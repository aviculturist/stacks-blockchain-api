import { inspect } from 'util';
import * as net from 'net';
import { Server, createServer } from 'http';
import * as express from 'express';
import * as bodyParser from 'body-parser';
import { addAsync } from '@awaitjs/express';
import PQueue from 'p-queue';
import * as expressWinston from 'express-winston';

import { hexToBuffer, logError, logger, digestSha512_256 } from '../helpers';
import {
  CoreNodeBlockMessage,
  CoreNodeEventType,
  CoreNodeBurnBlockMessage,
  CoreNodeDropMempoolTxMessage,
  CoreNodeAttachmentMessage,
  CoreNodeMicroblockMessage,
  CoreNodeParsedTxMessage,
  CoreNodeEvent,
} from './core-node-message';
import {
  DataStore,
  createDbTxFromCoreMsg,
  DbEventBase,
  DbSmartContractEvent,
  DbStxEvent,
  DbEventTypeId,
  DbFtEvent,
  DbAssetEventTypeId,
  DbNftEvent,
  DbBlock,
  DataStoreUpdateData,
  createDbMempoolTxFromCoreMsg,
  DbStxLockEvent,
  DbMinerReward,
  DbBurnchainReward,
  getTxDbStatus,
  DbRewardSlotHolder,
  DbBnsName,
  DbBnsNamespace,
  DbBnsSubdomain,
  DbMicroblock,
  DbMicroblockPartial,
  DataStoreMicroblockUpdateData,
  DbTx,
  DataStoreTxEventData,
} from '../datastore/common';
import {
  getTxSenderAddress,
  getTxSponsorAddress,
  parseMessageTransaction,
  CoreNodeMsgBlockData,
} from './reader';
import { TransactionPayloadTypeID, readTransaction } from '../p2p/tx';
import {
  addressToString,
  BufferCV,
  BufferReader,
  ChainID,
  deserializeCV,
  StringAsciiCV,
  TupleCV,
} from '@stacks/transactions';
import {
  getFunctionName,
  parseNameRawValue,
  parseNamespaceRawValue,
  parseResolver,
  parseZoneFileTxt,
} from '../bns-helpers';

import {
  printTopic,
  namespaceReadyFunction,
  nameFunctions,
  BnsContractIdentifier,
} from '../bns-constants';

import * as zoneFileParser from 'zone-file';

async function handleRawEventRequest(
  eventPath: string,
  payload: string,
  db: DataStore
): Promise<void> {
  await db.storeRawEventRequest(eventPath, payload);
}

async function handleBurnBlockMessage(
  burnBlockMsg: CoreNodeBurnBlockMessage,
  db: DataStore
): Promise<void> {
  logger.verbose(
    `Received burn block message hash ${burnBlockMsg.burn_block_hash}, height: ${burnBlockMsg.burn_block_height}`
  );
  logger.verbose(
    `Received burn block rewards for ${burnBlockMsg.reward_recipients.length} recipients`
  );
  const rewards = burnBlockMsg.reward_recipients.map((r, index) => {
    const dbReward: DbBurnchainReward = {
      canonical: true,
      burn_block_hash: burnBlockMsg.burn_block_hash,
      burn_block_height: burnBlockMsg.burn_block_height,
      burn_amount: BigInt(burnBlockMsg.burn_amount),
      reward_recipient: r.recipient,
      reward_amount: BigInt(r.amt),
      reward_index: index,
    };
    return dbReward;
  });
  const slotHolders = burnBlockMsg.reward_slot_holders.map((r, index) => {
    const slotHolder: DbRewardSlotHolder = {
      canonical: true,
      burn_block_hash: burnBlockMsg.burn_block_hash,
      burn_block_height: burnBlockMsg.burn_block_height,
      address: r,
      slot_index: index,
    };
    return slotHolder;
  });
  await db.updateBurnchainRewards({
    burnchainBlockHash: burnBlockMsg.burn_block_hash,
    burnchainBlockHeight: burnBlockMsg.burn_block_height,
    rewards: rewards,
  });
  await db.updateBurnchainRewardSlotHolders({
    burnchainBlockHash: burnBlockMsg.burn_block_hash,
    burnchainBlockHeight: burnBlockMsg.burn_block_height,
    slotHolders: slotHolders,
  });
}

async function handleMempoolTxsMessage(rawTxs: string[], db: DataStore): Promise<void> {
  logger.verbose(`Received ${rawTxs.length} mempool transactions`);
  // TODO: mempool-tx receipt date should be sent from the core-node
  const receiptDate = Math.round(Date.now() / 1000);
  const rawTxBuffers = rawTxs.map(str => hexToBuffer(str));
  const decodedTxs = rawTxBuffers.map(buffer => {
    const txId = '0x' + digestSha512_256(buffer).toString('hex');
    const bufferReader = BufferReader.fromBuffer(buffer);
    const parsedTx = readTransaction(bufferReader);
    const txSender = getTxSenderAddress(parsedTx);
    const sponsorAddress = getTxSponsorAddress(parsedTx);
    return {
      txId: txId,
      sender: txSender,
      sponsorAddress,
      txData: parsedTx,
      rawTx: buffer,
    };
  });
  const dbMempoolTxs = decodedTxs.map(tx => {
    logger.verbose(`Received mempool tx: ${tx.txId}`);
    const dbMempoolTx = createDbMempoolTxFromCoreMsg({
      txId: tx.txId,
      txData: tx.txData,
      sender: tx.sender,
      sponsorAddress: tx.sponsorAddress,
      rawTx: tx.rawTx,
      receiptDate: receiptDate,
    });
    return dbMempoolTx;
  });
  await db.updateMempoolTxs({ mempoolTxs: dbMempoolTxs });
}

async function handleDroppedMempoolTxsMessage(
  msg: CoreNodeDropMempoolTxMessage,
  db: DataStore
): Promise<void> {
  logger.verbose(`Received ${msg.dropped_txids.length} dropped mempool txs`);
  const dbTxStatus = getTxDbStatus(msg.reason);
  await db.dropMempoolTxs({ status: dbTxStatus, txIds: msg.dropped_txids });
}

async function handleMicroblockMessage(
  chainId: ChainID,
  msg: CoreNodeMicroblockMessage,
  db: DataStore
): Promise<void> {
  logger.verbose(`Received microblock with ${msg.transactions.length} txs`);
  const microblockMap = new Map<string, DbMicroblockPartial>();
  msg.transactions.forEach(tx => {
    if (!microblockMap.has(tx.microblock_hash)) {
      const dbMbPartial: DbMicroblockPartial = {
        microblock_hash: tx.microblock_hash,
        microblock_sequence: tx.microblock_sequence,
        microblock_parent_hash: tx.microblock_parent_hash,
        parent_index_block_hash: msg.parent_index_block_hash,
      };
      microblockMap.set(tx.microblock_hash, dbMbPartial);
    }
  });
  const dbMicroblocks = [...microblockMap.values()].sort(
    (a, b) => a.microblock_sequence - b.microblock_sequence
  );
  const parsedTxs: CoreNodeParsedTxMessage[] = [];
  msg.transactions.forEach(tx => {
    const blockData: CoreNodeMsgBlockData = {
      parent_index_block_hash: msg.parent_index_block_hash,
      microblock_hash: tx.microblock_hash,
      microblock_sequence: tx.microblock_sequence,
      // TODO(mb): should probably have better empty values here
      index_block_hash: '',
      block_hash: '',
      burn_block_time: -1,
      burn_block_height: -1,
      block_height: -1, // filled in during initial db insert
      parent_block_hash: '', // filled in during initial db insert
    };
    const parsedTx = parseMessageTransaction(chainId, tx, blockData, msg.events);
    if (parsedTx) {
      parsedTxs.push(parsedTx);
    }
  });
  const updateData: DataStoreMicroblockUpdateData = {
    microblocks: dbMicroblocks,
    txs: parseDataStoreTxEventData(parsedTxs, msg.events, {
      block_height: -1, // TODO: fill during initial db insert
      index_block_hash: '',
    }),
  };
  await db.updateMicroblocks(updateData);
}

async function handleClientMessage(
  chainId: ChainID,
  msg: CoreNodeBlockMessage,
  db: DataStore
): Promise<void> {
  const parsedTxs: CoreNodeParsedTxMessage[] = [];
  const blockData: CoreNodeMsgBlockData = {
    ...msg,
    microblock_hash: '',
    microblock_sequence: -1,
  };
  msg.transactions.forEach(item => {
    const parsedTx = parseMessageTransaction(chainId, item, blockData, msg.events);
    if (parsedTx) {
      parsedTxs.push(parsedTx);
    }
  });

  const dbBlock: DbBlock = {
    canonical: true,
    block_hash: msg.block_hash,
    index_block_hash: msg.index_block_hash,
    parent_index_block_hash: msg.parent_index_block_hash,
    parent_block_hash: msg.parent_block_hash,
    parent_microblock_hash: msg.parent_microblock,
    parent_microblock_sequence: msg.parent_microblock_sequence,
    block_height: msg.block_height,
    burn_block_time: msg.burn_block_time,
    burn_block_hash: msg.burn_block_hash,
    burn_block_height: msg.burn_block_height,
    miner_txid: msg.miner_txid,
  };

  logger.verbose(`Received block ${msg.block_hash} (${msg.block_height}) from node`, dbBlock);

  const dbMinerRewards: DbMinerReward[] = [];
  for (const minerReward of msg.matured_miner_rewards) {
    const dbMinerReward: DbMinerReward = {
      canonical: true,
      block_hash: minerReward.from_stacks_block_hash,
      index_block_hash: msg.index_block_hash,
      from_index_block_hash: minerReward.from_index_consensus_hash,
      mature_block_height: msg.block_height,
      recipient: minerReward.recipient,
      coinbase_amount: BigInt(minerReward.coinbase_amount),
      tx_fees_anchored: BigInt(minerReward.tx_fees_anchored),
      tx_fees_streamed_confirmed: BigInt(minerReward.tx_fees_streamed_confirmed),
      tx_fees_streamed_produced: BigInt(minerReward.tx_fees_streamed_produced),
    };
    dbMinerRewards.push(dbMinerReward);
  }

  logger.verbose(`Received ${dbMinerRewards.length} matured miner rewards`);

  const dbData: DataStoreUpdateData = {
    block: dbBlock,
    minerRewards: dbMinerRewards,
    txs: parseDataStoreTxEventData(parsedTxs, msg.events, msg),
  };

  await db.update(dbData);
}

function parseDataStoreTxEventData(
  parsedTxs: CoreNodeParsedTxMessage[],
  events: CoreNodeEvent[],
  blockData: {
    block_height: number;
    index_block_hash: string;
  }
): DataStoreTxEventData[] {
  const dbData: DataStoreTxEventData[] = parsedTxs.map(tx => {
    logger.verbose(`Received mined tx: ${tx.core_tx.txid}`);
    const dbTx: DataStoreUpdateData['txs'][number] = {
      tx: createDbTxFromCoreMsg(tx),
      stxEvents: [],
      stxLockEvents: [],
      ftEvents: [],
      nftEvents: [],
      contractLogEvents: [],
      smartContracts: [],
      names: [],
      namespaces: [],
    };
    if (tx.parsed_tx.payload.typeId === TransactionPayloadTypeID.SmartContract) {
      const contractId = `${tx.sender_address}.${tx.parsed_tx.payload.name}`;
      dbTx.smartContracts.push({
        tx_id: tx.core_tx.txid,
        contract_id: contractId,
        block_height: blockData.block_height,
        source_code: tx.parsed_tx.payload.codeBody,
        abi: JSON.stringify(tx.core_tx.contract_abi),
        canonical: true,
      });
    }
    return dbTx;
  });

  for (const event of events) {
    if (!event.committed) {
      logger.verbose(`Ignoring uncommitted tx event from tx ${event.txid}`);
      continue;
    }
    const dbTx = dbData.find(entry => entry.tx.tx_id === event.txid);
    if (!dbTx) {
      throw new Error(`Unexpected missing tx during event parsing by tx_id ${event.txid}`);
    }

    const dbEvent: DbEventBase = {
      event_index: event.event_index,
      tx_id: event.txid,
      tx_index: dbTx.tx.tx_index,
      block_height: blockData.block_height,
      canonical: true,
    };

    switch (event.type) {
      case CoreNodeEventType.ContractEvent: {
        const entry: DbSmartContractEvent = {
          ...dbEvent,
          event_type: DbEventTypeId.SmartContractLog,
          contract_identifier: event.contract_event.contract_identifier,
          topic: event.contract_event.topic,
          value: hexToBuffer(event.contract_event.raw_value),
        };
        dbTx.contractLogEvents.push(entry);
        if (
          event.contract_event.topic === printTopic &&
          (event.contract_event.contract_identifier === BnsContractIdentifier.mainnet ||
            event.contract_event.contract_identifier === BnsContractIdentifier.testnet)
        ) {
          const functionName = getFunctionName(event.txid, parsedTxs);
          if (nameFunctions.includes(functionName)) {
            const attachment = parseNameRawValue(event.contract_event.raw_value);
            const name: DbBnsName = {
              name: attachment.attachment.metadata.name.concat(
                '.',
                attachment.attachment.metadata.namespace
              ),
              namespace_id: attachment.attachment.metadata.namespace,
              address: addressToString(attachment.attachment.metadata.tx_sender),
              expire_block: 0,
              registered_at: blockData.block_height,
              zonefile_hash: attachment.attachment.hash,
              zonefile: '', // zone file will be updated in  /attachments/new
              latest: true,
              tx_id: event.txid,
              status: attachment.attachment.metadata.op,
              canonical: true,
              atch_resolved: false, // saving an unresolved BNS name
            };
            dbTx.names.push(name);
          }
          if (functionName === namespaceReadyFunction) {
            // event received for namespaces
            const namespace: DbBnsNamespace | undefined = parseNamespaceRawValue(
              event.contract_event.raw_value,
              blockData.block_height,
              event.txid,
              blockData.index_block_hash
            );
            if (namespace != undefined) {
              dbTx.namespaces.push(namespace);
            }
          }
        }
        break;
      }
      case CoreNodeEventType.StxLockEvent: {
        const entry: DbStxLockEvent = {
          ...dbEvent,
          event_type: DbEventTypeId.StxLock,
          locked_amount: BigInt(event.stx_lock_event.locked_amount),
          unlock_height: Number(event.stx_lock_event.unlock_height),
          locked_address: event.stx_lock_event.locked_address,
        };
        dbTx.stxLockEvents.push(entry);
        break;
      }
      case CoreNodeEventType.StxTransferEvent: {
        const entry: DbStxEvent = {
          ...dbEvent,
          event_type: DbEventTypeId.StxAsset,
          asset_event_type_id: DbAssetEventTypeId.Transfer,
          sender: event.stx_transfer_event.sender,
          recipient: event.stx_transfer_event.recipient,
          amount: BigInt(event.stx_transfer_event.amount),
        };
        dbTx.stxEvents.push(entry);
        break;
      }
      case CoreNodeEventType.StxMintEvent: {
        const entry: DbStxEvent = {
          ...dbEvent,
          event_type: DbEventTypeId.StxAsset,
          asset_event_type_id: DbAssetEventTypeId.Mint,
          recipient: event.stx_mint_event.recipient,
          amount: BigInt(event.stx_mint_event.amount),
        };
        dbTx.stxEvents.push(entry);
        break;
      }
      case CoreNodeEventType.StxBurnEvent: {
        const entry: DbStxEvent = {
          ...dbEvent,
          event_type: DbEventTypeId.StxAsset,
          asset_event_type_id: DbAssetEventTypeId.Burn,
          sender: event.stx_burn_event.sender,
          amount: BigInt(event.stx_burn_event.amount),
        };
        dbTx.stxEvents.push(entry);
        break;
      }
      case CoreNodeEventType.FtTransferEvent: {
        const entry: DbFtEvent = {
          ...dbEvent,
          event_type: DbEventTypeId.FungibleTokenAsset,
          asset_event_type_id: DbAssetEventTypeId.Transfer,
          sender: event.ft_transfer_event.sender,
          recipient: event.ft_transfer_event.recipient,
          asset_identifier: event.ft_transfer_event.asset_identifier,
          amount: BigInt(event.ft_transfer_event.amount),
        };
        dbTx.ftEvents.push(entry);
        break;
      }
      case CoreNodeEventType.FtMintEvent: {
        const entry: DbFtEvent = {
          ...dbEvent,
          event_type: DbEventTypeId.FungibleTokenAsset,
          asset_event_type_id: DbAssetEventTypeId.Mint,
          recipient: event.ft_mint_event.recipient,
          asset_identifier: event.ft_mint_event.asset_identifier,
          amount: BigInt(event.ft_mint_event.amount),
        };
        dbTx.ftEvents.push(entry);
        break;
      }
      case CoreNodeEventType.FtBurnEvent: {
        const entry: DbFtEvent = {
          ...dbEvent,
          event_type: DbEventTypeId.FungibleTokenAsset,
          asset_event_type_id: DbAssetEventTypeId.Burn,
          sender: event.ft_burn_event.sender,
          asset_identifier: event.ft_burn_event.asset_identifier,
          amount: BigInt(event.ft_burn_event.amount),
        };
        dbTx.ftEvents.push(entry);
        break;
      }
      case CoreNodeEventType.NftTransferEvent: {
        const entry: DbNftEvent = {
          ...dbEvent,
          event_type: DbEventTypeId.NonFungibleTokenAsset,
          asset_event_type_id: DbAssetEventTypeId.Transfer,
          recipient: event.nft_transfer_event.recipient,
          sender: event.nft_transfer_event.sender,
          asset_identifier: event.nft_transfer_event.asset_identifier,
          value: hexToBuffer(event.nft_transfer_event.raw_value),
        };
        dbTx.nftEvents.push(entry);
        break;
      }
      case CoreNodeEventType.NftMintEvent: {
        const entry: DbNftEvent = {
          ...dbEvent,
          event_type: DbEventTypeId.NonFungibleTokenAsset,
          asset_event_type_id: DbAssetEventTypeId.Mint,
          recipient: event.nft_mint_event.recipient,
          asset_identifier: event.nft_mint_event.asset_identifier,
          value: hexToBuffer(event.nft_mint_event.raw_value),
        };
        dbTx.nftEvents.push(entry);
        break;
      }
      case CoreNodeEventType.NftBurnEvent: {
        const entry: DbNftEvent = {
          ...dbEvent,
          event_type: DbEventTypeId.NonFungibleTokenAsset,
          asset_event_type_id: DbAssetEventTypeId.Burn,
          sender: event.nft_burn_event.sender,
          asset_identifier: event.nft_burn_event.asset_identifier,
          value: hexToBuffer(event.nft_burn_event.raw_value),
        };
        dbTx.nftEvents.push(entry);
        break;
      }
      default: {
        throw new Error(`Unexpected CoreNodeEventType: ${inspect(event)}`);
      }
    }
  }

  // Normalize event indexes from per-block to per-transaction contiguous series.
  for (const tx of dbData) {
    const sortedEvents = [
      tx.contractLogEvents,
      tx.ftEvents,
      tx.nftEvents,
      tx.stxEvents,
      tx.stxLockEvents,
    ]
      .flat()
      .sort((a, b) => a.event_index - b.event_index);
    tx.tx.event_count = sortedEvents.length;
    for (let i = 0; i < sortedEvents.length; i++) {
      sortedEvents[i].event_index = i;
    }
  }

  return dbData;
}

async function handleNewAttachmentMessage(msg: CoreNodeAttachmentMessage[], db: DataStore) {
  for (const attachment of msg) {
    if (
      attachment.contract_id === BnsContractIdentifier.mainnet ||
      attachment.contract_id === BnsContractIdentifier.testnet
    ) {
      const metadataCV: TupleCV = deserializeCV(hexToBuffer(attachment.metadata)) as TupleCV;
      const opCV: StringAsciiCV = metadataCV.data['op'] as StringAsciiCV;
      const op = opCV.data;
      const zonefile = Buffer.from(attachment.content.slice(2), 'hex').toString();
      if (op === 'name-update') {
        const name = (metadataCV.data['name'] as BufferCV).buffer.toString('utf8');
        const namespace = (metadataCV.data['namespace'] as BufferCV).buffer.toString('utf8');
        const zoneFileContents = zoneFileParser.parseZoneFile(zonefile);
        const zoneFileTxt = zoneFileContents.txt;
        const blockData = {
          index_block_hash: '',
          parent_index_block_hash: '',
          microblock_hash: '',
          microblock_sequence: -1,
          microblock_canonical: true,
        };
        // Case for subdomain
        if (zoneFileTxt) {
          // get unresolved subdomain
          let isCanonical = true;
          const dbTx = await db.getTxStrict({
            txId: attachment.tx_id,
            indexBlockHash: attachment.index_block_hash,
          });
          if (dbTx.found) {
            isCanonical = dbTx.result.canonical;
            blockData.index_block_hash = dbTx.result.index_block_hash;
            blockData.parent_index_block_hash = dbTx.result.parent_index_block_hash;
            blockData.microblock_hash = dbTx.result.microblock_hash;
            blockData.microblock_sequence = dbTx.result.microblock_sequence;
            blockData.microblock_canonical = dbTx.result.microblock_canonical;
          } else {
            logger.warn(
              `Could not find transaction ${attachment.tx_id} associated with attachment`
            );
          }
          // case for subdomain
          const subdomains: DbBnsSubdomain[] = [];
          for (let i = 0; i < zoneFileTxt.length; i++) {
            const zoneFile = zoneFileTxt[i];
            const parsedTxt = parseZoneFileTxt(zoneFile.txt);
            if (parsedTxt.owner === '') continue; //if txt has no owner , skip it
            const subdomain: DbBnsSubdomain = {
              name: name.concat('.', namespace),
              namespace_id: namespace,
              fully_qualified_subdomain: zoneFile.name.concat('.', name, '.', namespace),
              owner: parsedTxt.owner,
              zonefile_hash: parsedTxt.zoneFileHash,
              zonefile: parsedTxt.zoneFile,
              latest: true,
              tx_id: attachment.tx_id,
              canonical: isCanonical,
              parent_zonefile_hash: attachment.content_hash.slice(2),
              parent_zonefile_index: 0, //TODO need to figure out this field
              block_height: Number.parseInt(attachment.block_height, 10),
              zonefile_offset: 1,
              resolver: zoneFileContents.uri ? parseResolver(zoneFileContents.uri) : '',
              atch_resolved: true,
            };
            subdomains.push(subdomain);
          }
          await db.resolveBnsSubdomains(blockData, subdomains);
        }
      }
      await db.resolveBnsNames(zonefile, true, attachment.tx_id);
    }
  }
}

interface EventMessageHandler {
  handleRawEventRequest(eventPath: string, payload: string, db: DataStore): Promise<void> | void;
  handleBlockMessage(
    chainId: ChainID,
    msg: CoreNodeBlockMessage,
    db: DataStore
  ): Promise<void> | void;
  handleMicroblockMessage(
    chainId: ChainID,
    msg: CoreNodeMicroblockMessage,
    db: DataStore
  ): Promise<void> | void;
  handleMempoolTxs(rawTxs: string[], db: DataStore): Promise<void> | void;
  handleBurnBlock(msg: CoreNodeBurnBlockMessage, db: DataStore): Promise<void> | void;
  handleDroppedMempoolTxs(msg: CoreNodeDropMempoolTxMessage, db: DataStore): Promise<void> | void;
  handleNewAttachment(msg: CoreNodeAttachmentMessage[], db: DataStore): Promise<void> | void;
}

function createMessageProcessorQueue(): EventMessageHandler {
  // Create a promise queue so that only one message is handled at a time.
  const processorQueue = new PQueue({ concurrency: 1 });
  const handler: EventMessageHandler = {
    handleRawEventRequest: (eventPath: string, payload: string, db: DataStore) => {
      return processorQueue
        .add(() => handleRawEventRequest(eventPath, payload, db))
        .catch(e => {
          logError(`Error storing raw core node request data`, e, payload);
          throw e;
        });
    },
    handleBlockMessage: (chainId: ChainID, msg: CoreNodeBlockMessage, db: DataStore) => {
      return processorQueue
        .add(() => handleClientMessage(chainId, msg, db))
        .catch(e => {
          logError(`Error processing core node block message`, e, msg);
          throw e;
        });
    },
    handleMicroblockMessage: (chainId: ChainID, msg: CoreNodeMicroblockMessage, db: DataStore) => {
      return processorQueue
        .add(() => handleMicroblockMessage(chainId, msg, db))
        .catch(e => {
          logError(`Error processing core node microblock message`, e, msg);
          throw e;
        });
    },
    handleBurnBlock: (msg: CoreNodeBurnBlockMessage, db: DataStore) => {
      return processorQueue
        .add(() => handleBurnBlockMessage(msg, db))
        .catch(e => {
          logError(`Error processing core node burn block message`, e, msg);
          throw e;
        });
    },
    handleMempoolTxs: (rawTxs: string[], db: DataStore) => {
      return processorQueue
        .add(() => handleMempoolTxsMessage(rawTxs, db))
        .catch(e => {
          logError(`Error processing core node mempool message`, e, rawTxs);
          throw e;
        });
    },
    handleDroppedMempoolTxs: (msg: CoreNodeDropMempoolTxMessage, db: DataStore) => {
      return processorQueue
        .add(() => handleDroppedMempoolTxsMessage(msg, db))
        .catch(e => {
          logError(`Error processing core node dropped mempool txs message`, e, msg);
          throw e;
        });
    },
    handleNewAttachment: (msg: CoreNodeAttachmentMessage[], db: DataStore) => {
      return processorQueue
        .add(() => handleNewAttachmentMessage(msg, db))
        .catch(e => {
          logError(`Error processing new attachment message`, e, msg);
          throw e;
        });
    },
  };

  return handler;
}

export async function startEventServer(opts: {
  db: DataStore;
  chainId: ChainID;
  messageHandler?: EventMessageHandler;
  promMiddleware?: express.Handler;
}): Promise<net.Server> {
  const db = opts.db;
  const messageHandler = opts.messageHandler ?? createMessageProcessorQueue();

  let eventHost = process.env['STACKS_CORE_EVENT_HOST'];
  const eventPort = parseInt(process.env['STACKS_CORE_EVENT_PORT'] ?? '', 10);
  if (!eventHost) {
    throw new Error(
      `STACKS_CORE_EVENT_HOST must be specified, e.g. "STACKS_CORE_EVENT_HOST=127.0.0.1"`
    );
  }
  if (!eventPort) {
    throw new Error(`STACKS_CORE_EVENT_PORT must be specified, e.g. "STACKS_CORE_EVENT_PORT=3700"`);
  }

  if (eventHost.startsWith('http:')) {
    const { hostname } = new URL(eventHost);
    eventHost = hostname;
  }

  const app = addAsync(express());

  if (opts.promMiddleware) {
    app.use(opts.promMiddleware);
  }

  app.use(
    expressWinston.logger({
      winstonInstance: logger,
      metaField: (null as unknown) as string,
    })
  );

  app.use(bodyParser.json({ type: 'application/json', limit: '500MB' }));
  app.getAsync('/', (req, res) => {
    res
      .status(200)
      .json({ status: 'ready', msg: 'API event server listening for core-node POST messages' });
  });

  app.postAsync('*', async (req, res) => {
    const eventPath = req.path;
    const payload = JSON.stringify(req.body);
    await messageHandler.handleRawEventRequest(eventPath, payload, db);
  });

  app.postAsync('/new_block', async (req, res) => {
    try {
      const msg: CoreNodeBlockMessage = req.body;
      await messageHandler.handleBlockMessage(opts.chainId, msg, db);
      res.status(200).json({ result: 'ok' });
    } catch (error) {
      logError(`error processing core-node /new_block: ${error}`, error);
      res.status(500).json({ error: error });
    }
  });

  app.postAsync('/new_burn_block', async (req, res) => {
    try {
      const msg: CoreNodeBurnBlockMessage = req.body;
      await messageHandler.handleBurnBlock(msg, db);
      res.status(200).json({ result: 'ok' });
    } catch (error) {
      logError(`error processing core-node /new_burn_block: ${error}`, error);
      res.status(500).json({ error: error });
    }
  });

  app.postAsync('/new_mempool_tx', async (req, res) => {
    try {
      const rawTxs: string[] = req.body;
      await messageHandler.handleMempoolTxs(rawTxs, db);
      res.status(200).json({ result: 'ok' });
    } catch (error) {
      logError(`error processing core-node /new_mempool_tx: ${error}`, error);
      res.status(500).json({ error: error });
    }
  });

  app.postAsync('/drop_mempool_tx', async (req, res) => {
    try {
      const msg: CoreNodeDropMempoolTxMessage = req.body;
      await messageHandler.handleDroppedMempoolTxs(msg, db);
      res.status(200).json({ result: 'ok' });
    } catch (error) {
      logError(`error processing core-node /drop_mempool_tx: ${error}`, error);
      res.status(500).json({ error: error });
    }
  });

  app.postAsync('/attachments/new', async (req, res) => {
    try {
      const msg: CoreNodeAttachmentMessage[] = req.body;
      await messageHandler.handleNewAttachment(msg, db);
      res.status(200).json({ result: 'ok' });
    } catch (error) {
      logError(`error processing core-node /attachments/new: ${error}`, error);
      res.status(500).json({ error: error });
    }
  });

  app.postAsync('/new_microblocks', async (req, res) => {
    try {
      const msg: CoreNodeMicroblockMessage = req.body;
      await messageHandler.handleMicroblockMessage(opts.chainId, msg, db);
      res.status(200).json({ result: 'ok' });
    } catch (error) {
      logError(`error processing core-node /new_microblocks: ${error}`, error);
      res.status(500).json({ error: error });
    }
  });

  app.post('*', (req, res, next) => {
    res.status(404).json({ error: `no route handler for ${req.path}` });
    logError(`Unexpected event on path ${req.path}`);
    next();
  });

  app.use(
    expressWinston.errorLogger({
      winstonInstance: logger,
      metaField: (null as unknown) as string,
      blacklistedMetaFields: ['trace', 'os', 'process'],
    })
  );

  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', error => {
      reject(error);
    });
    server.listen(eventPort, eventHost as string, () => {
      resolve();
    });
  });

  const addr = server.address();
  if (addr === null) {
    throw new Error('server missing address');
  }
  const addrStr = typeof addr === 'string' ? addr : `${addr.address}:${addr.port}`;
  logger.info(`Event observer listening at: http://${addrStr}`);

  return server;
}
