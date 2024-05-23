import { describe, it, afterEach } from 'vitest';

/**
 * Tests that I need to cover for the GossipLog
 * 1. Run the test over a long period of time. Connect the nodes, create 2_000 entries on one, wait for them to replicate.
 * Then, disconnect them, create 1000 entries on one node, and then connect them. See how long it takes to catch up 
 * the nodes over time as we have more entries stored over time. 
 * 
 * 2. Check the data size of the POJO vs what's stored in the database. 
 * 
 * 3. Check the startup times where nodes already have n number of entries in them, and we add 50 new entries. See how long it takes for
 * the entries to be added and replicated. 
 */

describe.sequential('Long term gossiplog tests', async () => {
  const connectedEntryInterval = 3000;
  const disconnectedEntryInterval = 1000;
  const totalEntriesToCreate = 200_000;

  async function createEntries(numberOfEntries: number): Promise<void> {

  }

  for (let i = 0; i < totalEntriesToCreate; i += connectedEntryInterval + disconnectedEntryInterval) {
    await createEntries(connectedEntryInterval);
    // await replication to finish
    await createEntries(disconnectedEntryInterval);
    // await replication to finish
  }
})
