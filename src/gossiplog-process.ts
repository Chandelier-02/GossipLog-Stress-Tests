import { ReadWriteTransaction } from '@canvas-js/gossiplog';
import { GossipLog } from '@canvas-js/gossiplog/node';
import { gossiplog } from '@canvas-js/gossiplog/service';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { yamux } from '@chainsafe/libp2p-yamux';
import { bootstrap } from '@libp2p/bootstrap';
import { identify } from '@libp2p/identify';
import { PeerId } from '@libp2p/interface';
import { plaintext } from '@libp2p/plaintext';
import { tcp } from '@libp2p/tcp';
import { Libp2p, createLibp2p } from 'libp2p';
import { Environment } from '@canvas-js/okra-node';
import {
  AddGossipLogIdsToMissingIdsRequest,
  CreateEntriesResponse,
  ProcessReadyResponse,
  ReplicatedObject,
  RequestTypes,
  ServiceMap,
  StartGossipSubProcessResponse,
  WaitForReplicationToFinishResponse,
} from './types';
import { peerIdFromString } from '@libp2p/peer-id';
import fs from 'fs';
import PQueue from 'p-queue';

const getAddress = (port: number) => `/ip4/127.0.0.1/tcp/${port}`;

const DATABASE_NUM = 3;
const MAP_SIZE = 256_000_000;
const TOPIC = 'test-topic';
const LIBP2P_CONFIG = (peerId: PeerId, address: string, bootstrapList: string[]) => {
  return {
    peerId: peerId,
    start: false,
    addresses: { listen: [address] },
    transports: [tcp()],
    connectionEncryption: [plaintext()],
    streamMuxers: [yamux()],
    peerDiscovery: bootstrapList.length > 0 ? [bootstrap({ list: bootstrapList, timeout: 0 })] : [],
    connectionManager: {
      minConnections: bootstrapList.length,
      maxConnections: bootstrapList.length + 1,
      autoDialInterval: 1000,
    },

    services: {
      identify: identify({ protocolPrefix: 'canvas' }),

      pubsub: gossipsub({
        emitSelf: false,
        fallbackToFloodsub: false,
        allowPublishToZeroPeers: true,
        globalSignaturePolicy: 'StrictSign',
      }),

      gossiplog: gossiplog({ sync: true }),
    },
  };
};

function validateReplicatedObject(payload: unknown): payload is ReplicatedObject {
  if (typeof payload === 'object' && payload !== null) {
    const p = payload as ReplicatedObject;
    return typeof p.id === 'string';
  }
  return false;
}

function delay(ms: number) {
  return new Promise<void>(resolve => setTimeout(() => resolve(), ms));
}

export class GossipLogServiceProcess {
  name: string;
  #gossipLog: GossipLog<ReplicatedObject, void>;
  #libp2p: Libp2p<ServiceMap>;
  #missingEntries: Set<string> = new Set();

  public static async create(
    name: string,
    gossiplogPath: string,
    peerId: PeerId,
    port: number,
    bootstrapList: string[],
    missingEntries: string[]
  ): Promise<GossipLogServiceProcess> {
    const libp2p = await createLibp2p(LIBP2P_CONFIG(peerId, getAddress(port), bootstrapList));
    await libp2p.start();

    if (!fs.existsSync(gossiplogPath)) {
      fs.mkdirSync(gossiplogPath, { recursive: true });
    }

    const env = new Environment(gossiplogPath, { databases: DATABASE_NUM, mapSize: MAP_SIZE });
    // @ts-ignore
    const gossipLog = new GossipLog(env, { topic: TOPIC, apply: () => {}, validate: validateReplicatedObject });
    await gossipLog.write((_: ReadWriteTransaction) => {});

    await libp2p.services.gossiplog.subscribe(gossipLog);

    return new GossipLogServiceProcess(name, gossipLog, libp2p, missingEntries);
  }

  private constructor(
    name: string,
    gossipLog: GossipLog<ReplicatedObject, void>,
    libp2p: Libp2p<ServiceMap>,
    missingEntries: string[]
  ) {
    this.name = name;
    this.#gossipLog = gossipLog;
    this.#libp2p = libp2p;
    this.#missingEntries = new Set<string>(missingEntries);
  }

  public async *createEntries(entries: ReplicatedObject[]): AsyncGenerator<string> {
    for (const entry of entries) {
      const result = await this.#libp2p.services.gossiplog.append(TOPIC, entry);
      await delay(5);
      yield result.id;
    }
  }

  public addMissingId(id: string): void {
    this.#missingEntries.add(id);
  }

  public async waitForReplicationToFinish(): Promise<number> {
    return new Promise<number>(resolve => {
      if (this.#missingEntries.size === 0) {
        resolve(0);
        return;
      }

      const start = performance.now();
      const searchingForEntries = new Set<string>();
      const readQueue = new PQueue({ concurrency: 100 });

      const interval = setInterval(() => {
        if (this.#missingEntries.size === 0) {
          const end = performance.now();
          clearInterval(interval);
          resolve(end - start);
          return;
        }

        for (const missingId of this.#missingEntries) {
          if (!searchingForEntries.has(missingId)) {
            searchingForEntries.add(missingId);
          }
          readQueue.add(async () => {
            const hasId = await this.#gossipLog.has(missingId);
            if (hasId) {
              this.#missingEntries.delete(missingId);
              searchingForEntries.delete(missingId);
            }
          });
        }
      }, 50);
    });
  }
}

if (!process.send) {
  throw new Error('Process.send is not a function');
}
const ipcSend = process.send.bind(process);
const readyResponse: ProcessReadyResponse = {
  type: 'process-ready',
};
ipcSend(readyResponse);

process.on('uncaughtException', error => {
  console.error(error.message);
  console.error(error.stack);
});
process.on('unhandledRejection', reason => {
  console.error(reason);
});

let gossipLogServiceProcess!: GossipLogServiceProcess;
process.on('message', async (message: RequestTypes) => {
  switch (message.type) {
    case 'start-request': {
      const peerId = peerIdFromString(message.peerIdString);
      const privateKeyBuffer = Buffer.from(message.peerIdPrivatekey, 'base64');
      Object.defineProperty(peerId, 'privateKey', {
        configurable: true,
        writable: true,
        value: new Uint8Array(privateKeyBuffer.buffer, privateKeyBuffer.byteOffset, privateKeyBuffer.byteLength),
      });

      const start = performance.now();
      gossipLogServiceProcess = await GossipLogServiceProcess.create(
        message.name,
        message.gossipLogStoragePath,
        peerId,
        message.port,
        message.bootstrapList,
        message.missingEntryIds
      );
      await gossipLogServiceProcess.waitForReplicationToFinish();
      const end = performance.now();

      const startResponse: StartGossipSubProcessResponse = {
        type: 'start-response',
        responseId: message.requestId,
        timeTakenToLoadDocuments: end - start,
      };
      ipcSend(startResponse);
      break;
    }
    case 'create-entries-request': {
      const start = performance.now();
      let missingIds = []; // Store batches of 10 ids at a time
      for await (const id of gossipLogServiceProcess.createEntries(message.entries)) {
        missingIds.push(id);
        if (missingIds.length % 100 === 0) {
          const addMissingIdReq: AddGossipLogIdsToMissingIdsRequest = {
            type: 'add-missing-entry-ids-request',
            missingEntryIds: missingIds,
            fromNode: gossipLogServiceProcess.name,
          };
          ipcSend(addMissingIdReq);
          missingIds = [];
        }

        // Handle any remaining entries
        if (missingIds.length > 0) {
          const addMissingIdReq: AddGossipLogIdsToMissingIdsRequest = {
            type: 'add-missing-entry-ids-request',
            missingEntryIds: missingIds,
            fromNode: gossipLogServiceProcess.name,
          };
          ipcSend(addMissingIdReq);
        }
      }
      const end = performance.now();
      const createEntriesResponse: CreateEntriesResponse = {
        type: 'create-entries-response',
        responseId: message.requestId,
        timeToCreateEntries: end - start,
      };
      ipcSend(createEntriesResponse);
      break;
    }
    case 'add-missing-entry-ids-request': {
      for (const missingId of message.missingEntryIds) {
        gossipLogServiceProcess.addMissingId(missingId);
      }
      break;
    }
    case 'wait-for-replication-to-finish': {
      const timeTaken = await gossipLogServiceProcess.waitForReplicationToFinish();
      ipcSend({
        type: 'wait-for-replication-to-finish',
        timeTakenForReplicationToFinish: timeTaken,
        responseId: message.requestId,
      } as WaitForReplicationToFinishResponse);
    }
  }
});
