import { GossipLogService } from '@canvas-js/gossiplog/service';
import { PubSub } from '@libp2p/interface';

export type ProcessReadyResponse = {
  type: 'process-ready';
};

export type StartGossipSubProcessRequest = {
  requestId: string;
  type: 'start-request';
  name: string;
  peerIdString: string;
  peerIdPrivatekey: string; // Base64 encoded string
  port: number;
  nodeToConnectToPeerIdStrings: string[];
  gossipLogStoragePath: string;
  missingEntryIds: string[]; // GossipLog entry ids, not to be confused with ReplicatedObject ids
};

export type CreateEntriesRequest = {
  requestId: string;
  type: 'create-entries-request';
  entries: ReplicatedObject[]; // JSON encoded ReplicatedObject objects
};

export type AddGossipLogIdsToMissingIdsRequest = {
  type: 'add-missing-entry-ids-request';
  missingEntryIds: string[]; // GossipLog entry id
  fromNode: string;
};

export type WaitForReplicationToFinishRequest = {
  requestId: string;
  type: 'wait-for-replication-to-finish';
};

export type StartGossipSubProcessResponse = {
  responseId: string;
  type: 'start-response';
  timeTakenToLoadDocuments: number; // ms it took for the GossipLog to load documents from peers at startup
};

export type CreateEntriesResponse = {
  responseId: string;
  type: 'create-entries-response';
  timeToCreateEntries: number;
};

export type WaitForReplicationToFinishResponse = {
  responseId: string;
  type: 'wait-for-replication-to-finish';
  timeTakenForReplicationToFinish: number;
};

export type RequestTypes =
  | StartGossipSubProcessRequest
  | CreateEntriesRequest
  | AddGossipLogIdsToMissingIdsRequest
  | WaitForReplicationToFinishRequest;

export type ResponseTypes =
  | ProcessReadyResponse
  | StartGossipSubProcessResponse
  | CreateEntriesResponse
  | WaitForReplicationToFinishResponse;

export type ServiceMap = {
  identify: {};
  pubsub: PubSub;
  gossiplog: GossipLogService;
};

export type ReplicatedObject = {
  id: string;
};
