import axios, { AxiosError } from 'axios';
import * as ethers from 'ethers';
import { z } from 'zod';
import { getEthersSigningWallet, getRoomContract, supabase } from './config';
import { gmMessageAiChatOutputSchema, gmMessageInputSchema } from './schemas/gmMessage';
import { WsMessageTypes } from './schemas/wsServer';
import { Database } from './types/database.types';
import { RoundState } from './types/roomTypes';
import { sortObjectKeys } from './utils/auth';
import { processGmMessage } from './utils/messageHandler';
import { gmInstructDecisionInputSchema } from './utils/schemas';
import { wsServer } from './ws/server';

// TODO fixme, hardcoding bad
const HARDCODED_GM_ID = 57;
const AGENT_DECISION_TIMEOUT_MS = parseInt(process.env.AGENT_DECISION_TIMEOUT_MS || '30000'); // Default 30 seconds

export async function checkAndCreateRounds() {
  try {
    // Query rooms that need new rounds
    console.log('checking for rooms needing rounds');
    const { data: roomsNeedingRounds, error } = await supabase.rpc(
      'get_active_rooms_needing_rounds'
    );
    if (error) {
      console.error('Error fetching rooms:', error);
      return;
    }

    // Process each room that needs a new round
    for (const room of roomsNeedingRounds || []) {
      console.log('creating new round for room', room.id);
      await createNewRound(room);
      break;
    }
  } catch (error) {
    console.error('Error in checkAndCreateRounds:', error); // TODO turn back on if needed
  }
}

export async function createNewRound(
  room: Database['public']['Functions']['get_active_rooms_needing_rounds']['Returns'][0]
) {
  try {
    console.log(
      `creating new round for room (createNewRound) ${room.id} at ${room.contract_address} on chain ${room.chain_id}`
    );

    const contract = getRoomContract(room.contract_address, room.chain_id);
    const tx = await contract.startRound();
    const receipt = await tx.wait();

    if (receipt.status === 0) {
      console.error(`Failed to start round for room ${room.id}:`, receipt);
      throw new Error('Transaction failed');
    }

    const currentRound = await contract.currentRoundId();
    console.log('currentRound', currentRound);

    const { data: newRound, error: insertError } = await supabase
      .rpc('create_round_from_room', {
        room_id_param: room.id,
        underlying_contract_round: Number(currentRound),
      })
      .single();

    if (insertError) {
      console.error('Error creating new round:', insertError);
      return;
    }

    // console.log('new round created', newRound);
    console.log(`calling contract ${room.contract_address} startRound`);

    // console.log('logged receipt for startRound', receipt);
    // update the round status to OPEN
    const { data: roundData, error: updateError } = await supabase
      .from('rounds')
      .select('*, round_agents(*, agents(*))')
      .eq('id', newRound.id)
      .single();

    if (updateError) {
      console.error('Error updating round:', updateError);
    }
    if (!roundData) {
      console.error('Round data not found for round', newRound.id);
      return;
    }
    const backendEthersSigningWallet = getEthersSigningWallet(room.chain_id);

    await sendGmMessageToRoomOnly({
      roomId: newRound.room_id,
      sender: backendEthersSigningWallet.address,
      roundId: newRound.id,
      targets: [],
      message: 'Round #' + newRound.id + ' has started, you may place your bets now',
    });
    const { error: updateError3 } = await supabase
      .from('rounds')
      .update({ status: 'OPEN' })
      .eq('id', newRound.id)
      .eq('active', true);

    console.log('Updated round #', newRound.id, 'to OPEN');
    if (updateError3) {
      console.error('Error updating round to set started:', updateError3);
    }

    return;
  } catch (error) {
    console.error('Error in createNewRound:', error); // TODO turn back on if needed
  }
}

//Query the rounds that need to be closed and close them.
export async function checkAndCloseRounds() {
  try {
    // Query rounds that needs to be closed
    console.log('checking for rounds to close');
    const { data: roundsToClose, error } = await supabase.rpc('get_active_rounds_to_close');

    if (error) {
      console.error('Error fetching rounds:', error);
      return;
    }

    // Process each room that needs a new round
    for (const round of roundsToClose || []) {
      // console.log(room.id);
      await closeRound(round);
    }
  } catch (error) {
    // console.error('Error in checkAndCreateRounds:', error); // TODO turn back on if needed
  }
}

async function sendGmMessageToRoomOnly({
  roomId,
  sender,
  roundId,
  targets,
  message,
}: {
  roomId: number;
  sender: string;
  roundId: number;
  targets: number[];
  message: string;
}) {
  await wsServer.sendMessageToRoom({
    roomId,
    message: {
      messageType: WsMessageTypes.GM_MESSAGE,
      sender,
      signature: Date.now().toString(),
      content: sortObjectKeys({
        roomId,
        message,
        roundId,
        gmId: HARDCODED_GM_ID,
        timestamp: Date.now(),
        targets,
        ignoreErrors: false,
        additionalData: {},
      }),
    } satisfies z.infer<typeof gmMessageAiChatOutputSchema>,
  });
}

export async function closeRound(
  round: Database['public']['Functions']['get_active_rounds_to_close']['Returns'][0]
) {
  console.log(`Closing round ${round.id} for room ${round.room_id}`);

  try {
    const backendEthersSigningWallet = getEthersSigningWallet(round.chain_id);
    // Update round status to CLOSING
    await updateRoundStatus(round.id, 'CLOSING');
    console.log(`Round #${round.id} status updated to CLOSING`);

    // Get contract and set state to Processing
    const contract = getRoomContract(round.contract_address, round.chain_id);
    console.log(
      `Got room contract for address ${round.contract_address} on chain ${round.chain_id}`
    );

    await setContractRoundState(contract, RoundState.Processing);
    console.log(`Round #${round.id} contract state set to PROCESSING`);

    // Get active agents in the round
    const agents = await getActiveAgentsInRound(round.id);
    console.log(`Found ${agents.length} active agents for round #${round.id}`);

    if (!agents.length) {
      console.log(`No active agents found for round #${round.id}, skipping decision collection`);
      // Even with no agents, we should still finalize the round
      await finalizeRound(round, backendEthersSigningWallet, contract);
      return;
    }

    console.log(
      `Agents who need to submit decisions on round #${round.id}:`,
      agents.map((a) => a.id)
    );

    // Send instruction to submit decisions
    await sendDecisionInstructions(round, agents, backendEthersSigningWallet);
    console.log(`Sent decision instructions to all agents for round #${round.id}`);

    // Notify chat that we're waiting for responses
    await sendGmMessageToRoomOnly({
      roomId: round.room_id,
      sender: backendEthersSigningWallet.address,
      roundId: round.id,
      targets: [],
      message: 'GM finished asking agents to submit their decision, waiting for responses...',
    });
    console.log(`Notified chat about waiting for agent decisions for round #${round.id}`);

    // Wait for agents to submit their decisions
    console.log(`Waiting ${AGENT_DECISION_TIMEOUT_MS}ms for agent decisions...`);
    await new Promise((resolve) => setTimeout(resolve, AGENT_DECISION_TIMEOUT_MS));

    // Process agent decisions
    const receivedDecisions = await processAgentDecisions(round, contract);
    console.log(
      `Processed ${Object.keys(receivedDecisions).length} agent decisions for round #${round.id}`
    );

    // Send completion message and finalize round
    await finalizeRound(round, backendEthersSigningWallet, contract);

    console.log(`Successfully closed round #${round.id}`);
  } catch (error) {
    console.error(`Error closing round #${round.id}:`, error);

    // Attempt to update the round status to indicate an error occurred
    try {
      await supabase
        .from('rounds')
        .update({ status: 'CANCELLED', active: false, error_message: String(error) })
        .eq('id', round.id);
      console.log(`Updated round #${round.id} status to CANCELLED due to error`);
    } catch (updateError) {
      console.error(`Failed to update round #${round.id} status after error:`, updateError);
    }
  }
}

// Helper functions

async function updateRoundStatus(
  roundId: number,
  status: 'STARTING' | 'CLOSING' | 'OPEN' | 'CLOSED' | 'CANCELLED',
  active?: boolean
) {
  const updateData: {
    status: 'STARTING' | 'CLOSING' | 'OPEN' | 'CLOSED' | 'CANCELLED';
    active?: boolean;
  } = { status };

  if (active !== undefined) {
    updateData.active = active;
  }

  const { error } = await supabase
    .from('rounds')
    .update(updateData)
    .eq('id', roundId)
    .eq('active', true);

  if (error) {
    console.error(`Error updating round ${roundId} status to ${status}:`, error);
    throw new Error(`Failed to update round status: ${error.message}`);
  }
}

async function setContractRoundState(contract: ethers.Contract, state: RoundState) {
  try {
    console.log(`Setting round state to ${RoundState[state]}...`);
    const tx = await contract.setCurrentRoundState(state);
    console.log('Transaction sent:', tx.hash);

    // Add timeout to prevent indefinite hanging
    const receipt = await Promise.race([
      tx.wait(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Transaction confirmation timeout')), 30000)
      ),
    ]);

    console.log('Transaction confirmed, receipt:', receipt.transactionHash);
    return receipt;
  } catch (error) {
    console.error(`Failed to set round state to ${RoundState[state]}:`, error);
    throw error;
  }
}

async function getActiveAgentsInRound(roundId: number) {
  // Get non-kicked agents in the round
  const { data: roundAgents, error: roundAgentsError } = await supabase
    .from('round_agents')
    .select('*, rounds(rooms(room_agents(*)))')
    .eq('round_id', roundId)
    .eq('kicked', false);

  if (roundAgentsError) {
    console.error('Error fetching round agents:', roundAgentsError);
    throw roundAgentsError;
  }

  const agentIds = roundAgents.map((roundAgent) => roundAgent.agent_id);

  const { data: agents, error: agentsError } = await supabase
    .from('agents')
    .select('*')
    .in('id', agentIds);

  if (agentsError) {
    console.error('Error fetching agents:', agentsError);
    throw agentsError;
  }

  return agents || [];
}

async function sendDecisionInstructions(
  round: Database['public']['Functions']['get_active_rounds_to_close']['Returns'][0],
  agents: any[],
  wallet: any
) {
  // Prepare and send GM message to all agents
  const content = {
    message: 'We are closing the round, please submit your decision',
    roundId: round.id,
    gmId: HARDCODED_GM_ID,
    timestamp: Date.now(),
    targets: agents.map((a) => a.id),
    roomId: round.room_id,
    ignoreErrors: false,
    additionalData: {},
  };

  const signature = await wallet.signMessage(JSON.stringify(sortObjectKeys(content)));

  const message = {
    messageType: WsMessageTypes.GM_MESSAGE,
    sender: wallet.address,
    signature,
    content: sortObjectKeys(content),
  } satisfies z.infer<typeof gmMessageInputSchema>;

  await processGmMessage(message);

  // Send individual instructions to each agent
  const instructionPromises = agents.map((agent) => {
    const url = `${agent.endpoint}/messages/gmInstructDecision`;
    console.log(`Telling agent #${agent.id} at ${url} to submit their decision`);

    return axios
      .post(url, {
        messageType: WsMessageTypes.GM_INSTRUCT_DECISION,
        sender: wallet.address,
        signature: Date.now().toString(),
        content: sortObjectKeys({
          roomId: round.room_id,
          roundId: round.id,
        }),
      } satisfies z.infer<typeof gmInstructDecisionInputSchema>)
      .then(() => console.log(`Finished telling agent #${agent.id} to submit their decision`))
      .catch((error) => {
        console.error(`Error telling agent #${agent.id} to submit decision:`, error);
        // Don't throw here to allow other agents to continue
      });
  });

  await Promise.allSettled(instructionPromises);
}

async function processAgentDecisions(
  round: Database['public']['Functions']['get_active_rounds_to_close']['Returns'][0],
  contract: ethers.Contract
) {
  // Get updated agent data after they've had a chance to respond
  const { data: roundAgents, error } = await supabase
    .from('round_agents')
    .select('*, rounds(rooms(room_agents(*, agents(*))))')
    .eq('round_id', round.id)
    .eq('kicked', false);

  if (error) {
    console.error('Error fetching round agents for decisions:', error);
    throw new Error(`Failed to fetch round agents: ${error.message}`);
  }

  console.log(`Processing decisions for ${roundAgents.length} agents in round #${round.id}`);
  const receivedDecisions: Record<string, number> = {};

  // Process each agent's decision
  const decisionPromises = roundAgents.map(async (roundAgent) => {
    try {
      console.log(
        `Processing agent #${roundAgent.agent_id} decision, current outcome:`,
        roundAgent.outcome
      );
      let outcome = roundAgent.outcome ? JSON.parse(roundAgent.outcome as string) : null;

      // If no outcome, generate a random one (1=buy, 2=hold, 3=sell)
      if (!outcome || Object.keys(outcome).length === 0) {
        const decision = Math.floor(Math.random() * 3) + 1;
        console.log(
          `No decision found for agent #${roundAgent.agent_id}, generating random decision: ${decision}`
        );

        const { error: updateError } = await supabase
          .from('round_agents')
          .update({ outcome: { decision, fabricated: true } })
          .eq('agent_id', roundAgent.agent_id);

        if (updateError) {
          console.error(
            `Error updating fabricated outcome for agent #${roundAgent.agent_id}:`,
            updateError
          );
        }

        outcome = { decision, fabricated: true };
      }

      // Submit decision to contract (2 = processing)
      console.log(`Submitting agent #${roundAgent.agent_id} decision to contract`);
      const tx = await contract.submitAgentDecision(
        roundAgent.rounds.rooms.room_agents[0].wallet_address,
        2
      );
      const receipt = await tx.wait();
      console.log(
        `Agent #${roundAgent.agent_id} decision submitted, receipt:`,
        receipt.transactionHash
      );

      receivedDecisions[roundAgent.agent_id] = outcome.decision;
    } catch (error) {
      console.error(`Error processing decision for agent #${roundAgent.agent_id}:`, error);

      // Generate random decision as fallback
      const fallbackDecision = Math.floor(Math.random() * 3) + 1;
      console.log(`Using fallback decision ${fallbackDecision} for agent #${roundAgent.agent_id}`);

      try {
        await supabase
          .from('round_agents')
          .update({
            outcome: { decision: fallbackDecision, fabricated: true, error: String(error) },
          })
          .eq('id', roundAgent.agent_id);
      } catch (updateError) {
        console.error(
          `Failed to update fallback decision for agent #${roundAgent.agent_id}:`,
          updateError
        );
      }

      receivedDecisions[roundAgent.agent_id] = fallbackDecision;
    }
  });

  await Promise.allSettled(decisionPromises);
  return receivedDecisions;
}

async function finalizeRound(
  round: Database['public']['Functions']['get_active_rounds_to_close']['Returns'][0],
  wallet: ethers.Wallet,
  contract: ethers.Contract
) {
  const content = {
    message: `Round #${round.id} complete, you can withdraw your funds.`,
    roundId: round.id,
    gmId: HARDCODED_GM_ID,
    timestamp: Date.now(),
    targets: [],
    roomId: round.room_id,
    ignoreErrors: false,
    additionalData: {},
  };

  try {
    // Sign and send completion message
    const signature = await wallet.signMessage(JSON.stringify(sortObjectKeys(content)));

    await processGmMessage({
      messageType: WsMessageTypes.GM_MESSAGE,
      signature,
      sender: wallet.address,
      content: sortObjectKeys(content),
    } satisfies z.infer<typeof gmMessageAiChatOutputSchema>);

    console.log('Sent completion message to room participants');

    // Set contract round state to Closed
    await setContractRoundState(contract, RoundState.Closed);

    // Update database status
    await updateRoundStatus(round.id, 'CLOSED', false);
  } catch (error) {
    console.error(`Error finalizing round #${round.id}:`, error);
    throw error;
  }
}
