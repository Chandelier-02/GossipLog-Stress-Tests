import { PeerId } from '@libp2p/interface';
import { ChildProcess, spawn, exec } from 'child_process';
import path from 'path';
import {
  AddGossipLogIdsToMissingIdsRequest,
  CreateEntriesRequest,
  CreateEntriesResponse,
  ReplicatedObject,
  ResponseTypes,
  StartGossipSubProcessRequest,
  StartGossipSubProcessResponse,
  WaitForReplicationToFinishRequest,
  WaitForReplicationToFinishResponse,
} from './types';
import { promisify } from 'util';

type ChildGossipLogProcess = {
  name: string;
  peerId: PeerId;
  port: number;
  process: ChildProcess;
};

export type NetworkConfig = {
  name: string;
  port: number;
  peerId: PeerId;
}[];

function createReplicatedObject(): ReplicatedObject {
  return { id: crypto.randomUUID() };
}

export class GossipLogProcessManager {
  #gossipLogProcesses: Map<string, ChildGossipLogProcess>;
  #gossipSubBasePath = path.join(__dirname, '../test', 'test-data');
  messageHandlers: Map<string, Function> = new Map();

  constructor() {
    this.#gossipLogProcesses = new Map();
  }

  async init(networkConfig: NetworkConfig): Promise<void> {
    for (const config of networkConfig) {
      this.#gossipLogProcesses.set(config.name, { ...config, process: await this.#createProcess(config.name) });
    }
  }

  async #registerHandler(requestId: string, handler: Function) {
    this.messageHandlers.set(requestId, handler);
  }

  async #unregisterHandler(requestId: string) {
    this.messageHandlers.delete(requestId);
  }

  async #handleMessage(message: ResponseTypes | AddGossipLogIdsToMissingIdsRequest) {
    if ('fromNode' in message) {
      this.messageHandlers.get('missing-id-relayer')!(message);
      return;
    }
    if ('responseId' in message) {
      this.messageHandlers.get(message.responseId)!(message);
    }
  }

  #handleMissingIdRelayer(message: AddGossipLogIdsToMissingIdsRequest) {
    for (const [name, process] of this.#gossipLogProcesses.entries()) {
      if (name !== message.fromNode) {
        process.process.send(message);
      }
    }
  }

  async #createProcess(name: string): Promise<ChildProcess> {
    return new Promise<ChildProcess>(resolve => {
      const childProcess = spawn(
        'node',
        ['--loader', 'ts-node/esm', path.join(__dirname, '../src', 'gossiplog-process.ts')],
        {
          stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        }
      );
      childProcess.on('exit', () => {
        console.log(`Child process with name ${name} exited`);
      });
      childProcess.on('close', () => {
        console.log(`Child process with name ${name} closed`);
      });
      childProcess.on('error', error => {
        console.error(`Error on child process ${error.message}`);
      });
      childProcess.once('message', (message: ResponseTypes) => {
        if (message.type === 'process-ready') {
          resolve(childProcess);
        }
      });
      childProcess.on('message', this.#handleMessage.bind(this));
    });
  }

  async startProcess(name: string, missingEntryIds: string[] = []): Promise<number> {
    return new Promise<number>(resolve => {
      const gossipSubProcess = this.#gossipLogProcesses.get(name)!;
      const requestId = crypto.randomUUID();
      const startProcessRequest: StartGossipSubProcessRequest = {
        name,
        gossipLogStoragePath: path.join(this.#gossipSubBasePath, name),
        port: gossipSubProcess.port,
        peerIdString: gossipSubProcess.peerId.toString(),
        peerIdPrivatekey: Buffer.from(gossipSubProcess.peerId.privateKey!).toString('base64'),
        missingEntryIds,
        nodeToConnectToPeerIdStrings: Array.from(this.#gossipLogProcesses.keys()).filter(key => key !== name),
        type: 'start-request',
        requestId,
      };
      const handler = (message: StartGossipSubProcessResponse) => {
        this.#unregisterHandler(requestId);
        this.#registerHandler('missing-id-relayer', this.#handleMissingIdRelayer.bind(this));
        resolve(message.timeTakenToLoadDocuments);
      };
      this.#registerHandler(requestId, handler.bind(this));
      gossipSubProcess.process.send(startProcessRequest);
    });
  }

  async createEntries(name: string, numberOfEntries: number): Promise<number> {
    return new Promise<number>(resolve => {
      const gossipSubProcess = this.#gossipLogProcesses.get(name)!;
      const requestId = crypto.randomUUID();
      const entries = [];
      for (let i = 0; i < numberOfEntries; i++) {
        entries.push(createReplicatedObject());
      }
      const handler = (message: CreateEntriesResponse) => {
        this.#unregisterHandler(requestId);
        resolve(message.timeToCreateEntries);
      };
      this.#registerHandler(requestId, handler.bind(this));

      const createEntriesRequest: CreateEntriesRequest = {
        type: 'create-entries-request',
        entries,
        requestId,
      };
      gossipSubProcess.process.send(createEntriesRequest);
    });
  }

  async waitForReplicationToFinish(name: string): Promise<number> {
    return new Promise<number>(resolve => {
      const gossipSubProcess = this.#gossipLogProcesses.get(name)!;
      const requestId = crypto.randomUUID();
      const handler = (message: WaitForReplicationToFinishResponse) => {
        this.#unregisterHandler(requestId);
        resolve(message.timeTakenForReplicationToFinish);
      };
      this.#registerHandler(requestId, handler.bind(this));

      const waitForReplicationRequest: WaitForReplicationToFinishRequest = {
        requestId,
        type: 'wait-for-replication-to-finish',
      };
      gossipSubProcess.process.send(waitForReplicationRequest);
    });
  }

  async blockPortConnection(name: string): Promise<void> {
    const port = this.#gossipLogProcesses.get(name)!.port;
    try {
      const blockInboundCommand = `sudo iptables -A INPUT -p tcp --dport ${port} -j DROP`;
      const blockOutboundCommand = `sudo iptables -A OUTPUT -p tcp --dport ${port} -j DROP`;
      await promisify(exec)(blockInboundCommand);
      await promisify(exec)(blockOutboundCommand);
    } catch (error) {
      console.log(error);
    }
  }

  async unblockPortConnection(name: string): Promise<void> {
    const port = this.#gossipLogProcesses.get(name)!.port;
    try {
      const unblockInboundCommand = `sudo iptables -D INPUT -p tcp --dport ${port} -j DROP`;
      const unblockOutboundCommand = `sudo iptables -D OUTPUT -p tcp --dport ${port} -j DROP`;
      await promisify(exec)(unblockInboundCommand);
      await promisify(exec)(unblockOutboundCommand);
    } catch (error) {
      console.log(error);
    }
  }

  async killChildProcesses(): Promise<void> {
    const killPromises = [];
    for (const childProcess of this.#gossipLogProcesses.values()) {
      killPromises.push(
        new Promise<void>(resolve => {
          childProcess.process.removeAllListeners();
          childProcess.process.once('close', () => resolve());
          childProcess.process.kill();
        })
      );
    }
    await Promise.all(killPromises);
  }
}
