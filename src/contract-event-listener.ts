// import { roundService } from '../services/roundService';
import { ethers } from 'ethers';
import { z } from 'zod';
import { getEthersProvider, supabase, wsOps } from './config';
import { agentMessageAgentOutputSchema } from './schemas/agentMessage';
import { pvpActionEnactedAiChatOutputSchema, PvpActions } from './schemas/pvp';
import { WsMessageTypes } from './schemas/wsServer';
import { roomAbi } from './types/contract.types';
import { Database } from './types/database.types';
import { sendMessageToAgent } from './utils/messageHandler';
import { decodePvpInvokeParameters, getPvpActionFromVerb } from './utils/pvp';

// Add a flag to track if we've already processed an event
const processedEvents = new Set<string>();
// Add this event to our processed set

// Helper function to compute the hash of an indexed string
function getIndexedStringHash(str: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(str));
}

export function hexToString(hex: string): string {
  // Remove '0x' prefix if present
  const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
  // Convert hex to buffer then to string
  return Buffer.from(cleanHex, 'hex').toString('utf8');
}

function logAvailableEvents(abi: any[]) {
  const events = abi.filter((item) => item.type === 'event');
  console.log('\nAvailable events in contract:');
  events.forEach((event) => {
    console.log(`- ${event.name}`);
    console.log('  Parameters:', event.inputs);
  });
}

export async function startContractEventListener(roomId: number) {
  try {
    const { data: room, error: roomError } = await supabase
      .from('rooms')
      .select('*')
      .eq('id', roomId)
      .single();

    if (roomError) {
      console.error('Error fetching room:', roomError);
      return;
    }

    const provider = getEthersProvider(room.chain_id);

    // Verify provider connection
    const network = await provider.getNetwork();
    console.log('network', network);

    console.log('Connected to network:', network.name, 'chainId:', network.chainId);

    if (!room.contract_address) {
      throw new Error(
        'No contract address found for room #' + room.id + " can't listen to contract"
      );
    }
    const contractAddress = room.contract_address;
    const contract = new ethers.Contract(contractAddress, roomAbi, provider);

    // Verify contract connection
    const code = await provider.getCode(contractAddress);
    if (code === '0x') {
      throw new Error('No contract found at address: ' + contractAddress);
    }

    console.log(
      'Starting contract event listener on room #',
      room.id,
      'with address',
      contractAddress
    );

    // Create mapping of all possible verb hashes
    const verbHashToString: Record<string, string> = {
      [getIndexedStringHash('attack')]: 'attack',
      [getIndexedStringHash('silence')]: 'silence',
      [getIndexedStringHash('deafen')]: 'deafen',
      [getIndexedStringHash('poison')]: 'poison',
    };

    // Set up event filters
    const roundStartedFilter = contract.filters.RoundStarted();
    const roundStateUpdatedFilter = contract.filters.RoundStateUpdated();
    const pvpActionInvokedFilter = contract.filters.PvpActionInvoked();

    // Listen using filters
    contract.on(roundStartedFilter, async (eventPayload) => {
      // The args array contains the decoded parameters in order
      const [roundId, startTime, endTime] = eventPayload.args;

      console.log('RoundStarted event:', {
        roundId: roundId,
        startTime: startTime, // Convert from unix timestamp if needed
        endTime: endTime, // Convert from unix timestamp if needed
        blockNumber: eventPayload.log.blockNumber,
        transactionHash: eventPayload.log.transactionHash,
      });
    });

    contract.on(roundStateUpdatedFilter, async (eventPayload) => {
      const [roundId, newState] = eventPayload.args;
      console.log('RoundStateUpdated event:', {
        roundId: roundId,
        newState: newState,
        blockNumber: eventPayload.log.blockNumber,
        transactionHash: eventPayload.log.transactionHash,
      });
    });

    contract.on(pvpActionInvokedFilter, async (eventPayload) => {
      console.log('Transaction hash', eventPayload.log.transactionHash);
      if (processedEvents.has(eventPayload.log.transactionHash)) {
        console.log('Skipping duplicate event:', eventPayload.log.transactionHash);
        return;
      }

      processedEvents.add(eventPayload.log.transactionHash);

      // Clear old events periodically to prevent memory leaks
      // setTimeout(() => processedEvents.delete(eventPayload.log.transactionHash), 60000); // Clear after 1 minute
      const [contractRoundId, verbHash, targetAddress, endTime, parameters] = eventPayload.args;
      console.log('\n=== PvpActionInvoked Event Details ===');

      // Get transaction details to find the sender
      const transaction = await eventPayload.getTransaction();
      const instigatorAddress = transaction.from;

      // Decode the verb
      const verb = verbHashToString[verbHash.hash];
      if (!verb) {
        console.error('Unknown verb hash:', verbHash.hash);
        return;
      }

      console.log(eventPayload);
      // Decode the parameters
      const decodedParameters = decodePvpInvokeParameters(verb, parameters);
      if (!decodedParameters) {
        console.error('Failed to decode parameters');
        return;
      }

      const { data: room, error: roomError } = await supabase
        .from('rooms')
        .select('id')
        .eq('contract_address', contractAddress)
        .single();

      if (roomError) {
        console.error('Error fetching room:', roomError);
        return;
      }

      console.log('room.id', room.id);
      const { data: round, error: roundError } = await supabase
        .from('rounds')
        .select('id, round_agents(*, agents(*))')
        .eq('room_id', room.id)
        .eq('status', 'OPEN')
        .eq('active', true)
        .single();

      if (roundError) {
        if (roundError.code === 'PGRST106') {
          console.error(`No open round found for room ${room.id}, skipping pvp notification`);
          return;
        }
        console.error('Error fetching round:', roundError);
        return;
      }

      // Create a structured object matching your schema types
      const pvpAction = getPvpActionFromVerb(verb, targetAddress, decodedParameters);

      // Log the decoded data
      console.log('\nDecoded Data:');
      console.log('- Verb:', verb);
      console.log('- TargetAddress:', targetAddress);
      console.log('- End Time:', endTime);
      console.log('- Decoded Parameters:', decodedParameters);
      console.log('\nStructured PVP Action:', pvpAction);

      const pvpActionMessage = {
        messageType: WsMessageTypes.PVP_ACTION_ENACTED,
        signature: `PvP Action from ${instigatorAddress} - ${Date.now()}`,
        sender: targetAddress,
        content: {
          roundId: round.id,
          instigatorAddress: instigatorAddress,
          txHash: eventPayload.log.transactionHash,
          // toString() so postgres can handle it when calling JSON.stringify()
          timestamp: Date.now(),
          effectEndTime: Number(endTime),
          roomId: room.id,
          action: pvpAction,
        },
      } satisfies z.infer<typeof pvpActionEnactedAiChatOutputSchema>;

      await wsOps.broadcastToAiChat({
        roomId: room.id,
        record: {
          agent_id: 57, //TODO hardcoding so bad, feels so bad, profound sadness, mama GM
          message: pvpActionMessage,
          round_id: round.id,
          message_type: WsMessageTypes.PVP_ACTION_ENACTED,
          original_author: null,
          pvp_status_effects: {}, // Our contract is the source of truth, this field is an artifact
        } satisfies Database['public']['Tables']['round_agent_messages']['Insert'],
      });

      if (pvpAction.actionType === PvpActions.ATTACK) {
        console.log(
          `Enacting attack, will send the following DM to ${pvpAction.parameters.target}: ${pvpAction.parameters.message}`
        );
        console.log('target', pvpAction.parameters.target);

        //TODO this query broken, just querying agents application wallet for demo
        // const { data: agent, error: agentError } = await supabase
        //   .from('agents')
        //   .select('*, room_agents(*)')
        //   .or(
        //     `eth_wallet_address.eq.${pvpAction.parameters.target},room_agents.wallet_address.eq.${pvpAction.parameters.target}`
        //   )
        //   .eq('room_agents.room_id', room.id)
        //   .single();

        const { data: agent, error: agentError } = await supabase
          .from('agents')
          .select('*')
          .eq('eth_wallet_address', pvpAction.parameters.target)
          .single();

        if (agentError) {
          console.error('Error fetching agent:', agentError);
          return;
        }

        if (!agent) {
          console.error('No agent found for target:', pvpAction.parameters.target);
          return;
        }

        console.log(`Agent with wallet address ${pvpAction.parameters.target} found: ${agent}`);

        const message = {
          messageType: WsMessageTypes.AGENT_MESSAGE,
          signature: `PvP Attack from ${instigatorAddress} - ${Date.now()}`,
          sender: targetAddress,
          content: {
            roundId: round.id,
            text: pvpAction.parameters.message,
            timestamp: Date.now(),
            roomId: room.id,
            agentId: 57,
          },
        } satisfies z.infer<typeof agentMessageAgentOutputSchema>;

        await sendMessageToAgent({ agent, message });
      }
    });
  } catch (error) {
    console.error('Error in startContractEventListener:', error);
    // Retry after delay
    setTimeout(() => {
      startContractEventListener(roomId).catch(console.error);
    }, 5000);
  }
}
