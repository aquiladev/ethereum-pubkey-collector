
/*******************************************************************************
 * Public Key Collector
 * This scans through the Ethereum blockchain pulling public keys from confirmed
 * transactions and sends new addresses to the api.
 * This service will also watch for new transactions as they appear. 
 ******************************************************************************/

'use strict'
const Web3 = require('web3')
const net = require('net')
const BN = require('bn.js')
const assert = require('assert')
const winston = require('winston')
const util = require('ethereumjs-util')
const { Transaction } = require('ethereumjs-tx')
const fs = require('fs')
const azure = require("azure-storage")

// Set up the configuration - currently set for the docker containers
const config = {
  provider: new Web3.providers.WebsocketProvider(`wss://mainnet.infura.io/ws/v3/${process.env.INFURA_API_KEY}`),
  // provider: new Web3.providers.IpcProvider('\\\\.\\pipe\\geth.ipc', net),
  // chainId: 1, // 1 is default for the mainnet.
  dataStore: './data/pkcollector.json', // stores current stats
  storage_connection_string: process.env.TEST_STORAGE_CONNECTION,
  storage_table: 'pkAddress'
};

console.log(config)

const logger = winston.createLogger({
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ level, message, timestamp }) => `${timestamp} ${level}: ${message}`)
      )
    }),
  ]
});

/* Main Function */
async function main() {

  // initialise the main class
  let pkCollector = new PublicKeyCollector(config);
  await pkCollector.initialize();

  let syncEmitter = pkCollector.syncEmitter();

  syncEmitter.on("changed", async (syncing) => {
    if (syncing == undefined) {
      logger.error("Syncing status undefined. Exiting");
      return;
    }
    else if (syncing)
      logger.info("Node is currently syncing. Waiting until sync completes...");
    else if (!syncing) {
      logger.info("Syncing Complete. Processing blocks...")
      await pkCollector.processBlocks()
      logger.info("Completed searching.");
      // We are up to date.
      // Now continue the update process for new blocks.
      await pkCollector.continualUpdate();
    }
  });

  // Check if we are syncing.
  let isSyncing = await pkCollector.isSyncing();
  if (!isSyncing) { // not syncing

    logger.info("Processing blocks...")
    await pkCollector.processBlocks()
    logger.info("Completed searching.");
    // We are up to date.
    // Now continue the update process for new blocks.
    await pkCollector.continualUpdate();
  }
  else {
    logger.info("Node is currently syncing. Waiting until it completes...");
  }
}

/**
 * PublicKeyCollector class holds the state information, including the Web3
 * connection, api connection and block processing.
 * The majority of the logic is contained within this class.
 * @param config - The object that holds configuration data.
 */
class PublicKeyCollector {

  constructor(config) {
    // Set up initial state variables
    this.currentBlock = 0;
    this.lastBlock = 0;
    this.failedBlocks = [];
    this.failedTxs = [];
    this.transactionTally = 0;
    this.chainId = config.chainId;
    this.updateMode = false; // we are not updating single blocks yet.
    this.web3 = new Web3(config.provider);
    this.dataStore = config.dataStore;
    this.tableService = azure.createTableService(config.storage_connection_string);
    this.table = config.storage_table;
    this.tableService.createTableIfNotExists(config.storage_table, function (error, result) {
      if (error) {
        logger.error(error);
        throw new Error(error);
      }
      logger.info("Ensure table:", result);
    });
  }

  /**
   * Sets up the global database connection and initializes the state
   * variables.
   */
  async initialize() {
    let blockNumber = await this.web3.eth.getBlockNumber()
    this.lastBlock = blockNumber;

    logger.info(blockNumber);

    logger.info("Checking for past processing...");
    if (fs.existsSync(this.dataStore)) {
      let dataVars = JSON.parse(fs.readFileSync(this.dataStore, 'utf8'));
      // explicitly add them to the class variables 
      if (dataVars.currentBlock)
        this.currentBlock = dataVars.currentBlock;
      if (dataVars.failedBlocks)
        this.failedBlocks = dataVars.failedBlocks;
      if (dataVars.failedTxs)
        this.failedTxs = dataVars.failedTxs;

      logger.info("Loaded previous state");
      logger.info("Blocks processed:" + this.currentBlock);
      if (this.failedBlocks.length !== 0) {
        logger.info("Failed blocks found. Reprocessing failed blocks");
        await this._processFailedBlocks();
        logger.info("Completed processing of failed blocks");
      }
    }
    else
      logger.info("No previous state found. Starting from scratch...");
  }

  /**
   * Process an individual transaction
   * this returns an address and its public key given a transaction
   */
  _processTransaction(transaction) {
    const txParams = {
      data: transaction.input,
      gasLimit: util.toBuffer(new BN(transaction.gas)),
      gasPrice: util.toBuffer(new BN(transaction.gasPrice)),
      nonce: util.toBuffer(new BN(transaction.nonce)),
      r: transaction.r,
      s: transaction.s,
      to: transaction.to,
      v: transaction.v,
      value: util.toBuffer(new BN(transaction.value)),
    };
    const tx = new Transaction(txParams)
    assert(transaction.hash === util.bufferToHex(tx.hash()))

    const pubKey = tx.getSenderPublicKey()
    const derivedAddress = util.bufferToHex(util.pubToAddress(pubKey))

    assert(derivedAddress.toLowerCase() === transaction.from.toLowerCase())
    return {
      address: transaction.from.toLowerCase(),
      pubKey: util.bufferToHex(pubKey),
    }
  }

  _insertPk(pkObj) {
    const self = this;
    return new Promise(function (resolve, reject) {
      const { address, pubKey } = pkObj;
      const entity = {
        PartitionKey: azure.TableUtilities.entityGenerator.String(address),
        RowKey: azure.TableUtilities.entityGenerator.String(pubKey)
      };

      self.tableService.insertOrReplaceEntity(self.table, entity, function (error) {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  /* Update any statistics we want to store. Currently just the successful
   * block number 
   */
  _updateStats() {
    let stats = JSON.stringify({
      currentBlock: this.currentBlock,
      failedBlocks: this.failedBlocks,
      failedTxs: this.failedTxs
    });
    fs.writeFileSync(this.dataStore, stats);
  }

  /**
   * This batch processes blocks until it reaches the current block height.
   * The transactions within each block are processed and the public keys
   * are sent to the api.
   */
  async processBlocks() {
    while (this.currentBlock < this.lastBlock) {
      if (this.currentBlock % 1000 == 0 && this.currentBlock != 0) {
        logger.info(`Transactions Processed (last 1000 blocks): ${this.transactionTally}`)
        this.transactionTally = 0;
        logger.info(`Processing Block ${this.currentBlock}`)
      }

      // process the current block
      await this._processBlock(this.currentBlock)

      if (this.currentBlock >= this.lastBlock)
        break;
      // Exit the loop if we are only updating a single block
      if (this.updateMode)
        break;

      // Lets process the next block
      this.currentBlock++;
      // If we are approaching the last block
      if (this.lastBlock - this.currentBlock < 5) {
        let blockNumber = await this.web3.eth.getBlockNumber()
        this.lastBlock = blockNumber;
      }
    }
  }

  async _processFailedBlocks() {
    var failedBlocks = this.failedBlocks.slice(0);
    for (let i = 0; i < failedBlocks.length; i++) {
      logger.info(`Processing failed block: ${failedBlocks[i]}`)
      await this._processBlock(failedBlocks[i])
    }
  }

  /**
   * This processes an individual block
   * The transactions within each block are processed and the public keys
   * are sent to the api.
   */
  async _processBlock(blockNumber) {
    // if the current block is in failed-blocks list. Remove it. 
    let index = this.failedBlocks.indexOf(blockNumber)
    if (index > -1) {
      this.failedBlocks.splice(index, 1);
    }

    let blockData = await this.web3.eth.getBlock(blockNumber, true)
    if (blockData.transactions.length != 0) {
      for (let i = 0; i < blockData.transactions.length; i++) {
        // Only process transactions we haven't seen before.
        if (blockData.transactions[i].nonce == 0) {
          this.transactionTally += 1;
          try {
            const { address, pubKey } = this._processTransaction(blockData.transactions[i]);
            await this._insertPk({ address, pubKey })
          }
          catch (error) {
            this.failedTxs.push({ block: blockNumber, txHash: blockData.transactions[i].hash })
            logger.error(error)
          }
        }
      }
    }

    await this._updateStats();
  }
  /**
   * This updates the database as blocks are found.
   * This is designed for perpetual real-time updates of the
   * database
   */
  continualUpdate() {
    logger.info("Starting the continual update...")
    this.updateMode = true;
    this.web3.eth.subscribe('newBlockHeaders')
      .on('data', (blockHeader) => {
        logger.info(`Processing Block: ${blockHeader.number}`)
        this.currentBlock = blockHeader.number;
        this.lastBlock = blockHeader.number;
        this.processBlocks(); // Process this new block
      })
  }

  syncEmitter() {
    return this.web3.eth.subscribe('syncing')
  }

  isSyncing() {
    return this.web3.eth.isSyncing();
  }
}

// execute the main function
main() 
