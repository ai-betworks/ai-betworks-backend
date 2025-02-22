import { ethers } from 'ethers';
import { z } from 'zod';
import {  getEthersProvider, getRoomContract } from '../config';
import { agentMessageAiChatOutputSchema, agentMessageInputSchema } from '../schemas/agentMessage';
import {
  AllPvpParametersType,
  attackActionSchema,
  deafenStatusSchema,
  poisonStatusSchema,
  PvpActions,
  PvpAllPvpActionsType,
  silenceStatusSchema,
} from '../schemas/pvp';
import { WsMessageTypes } from '../schemas/wsServer';
import { AllAgentChatMessageSchemaTypes } from './schemas';
/**
 * Defines the structure of PvP status data returned from the smart contract
 */
interface PvpStatus {
  endTime: number; // Unix timestamp when the effect expires
  instigator: string; // Address of who applied the effect
  parameters: AllPvpParametersType; // Hex-encoded JSON string containing effect parameters
  verb: string; // The type of effect (e.g., 'silence', 'deafen', 'poison')
}

/**
 * Core response type for PvP message processing
 * Aligns with database schema for round_agent_messages
 */
export interface PvPResult {
  currentBlockTimestamp: number;
  originalMessage: AllAgentChatMessageSchemaTypes;
  // originalTargets: number[];
  targetMessages: Record<number, z.infer<typeof agentMessageInputSchema>>;
  appliedEffects: PvpAllPvpActionsType[];
  pvpStatusEffects: z.infer<typeof agentMessageAiChatOutputSchema>['content']['pvpStatusEffects'];
}

/**
 * Type representing a valid agent message that can be processed by PvP
 */
type AgentMessage = Extract<
  AllAgentChatMessageSchemaTypes,
  {
    messageType: typeof WsMessageTypes.AGENT_MESSAGE;
    content: {
      timestamp: number;
      roomId: number;
      roundId: number;
      agentId: number;
      text: string;
      context?: any[];
    };
  }
>;

/**
 * Decodes hex-encoded parameters from contract
 */
function decodeParameters(parametersHex: string, verb: string): any {
  try {
    const cleanHex = parametersHex.startsWith('0x') ? parametersHex.slice(2) : parametersHex;
    const parametersStr = Buffer.from(cleanHex, 'hex').toString('utf8');
    const rawParameters = JSON.parse(parametersStr);

    // Convert target address if present
    if (rawParameters.target) {
      rawParameters.target = ethers.getAddress(rawParameters.target.toString(16));
    }

    // Validate parameters based on verb type
    switch (verb.toUpperCase()) {
      case PvpActions.ATTACK:
        return attackActionSchema.shape.parameters.parse(rawParameters);
      case PvpActions.SILENCE:
        return silenceStatusSchema.shape.parameters.parse(rawParameters);
      case PvpActions.DEAFEN:
        return deafenStatusSchema.shape.parameters.parse(rawParameters);
      case PvpActions.POISON:
        return poisonStatusSchema.shape.parameters.parse(rawParameters);
      default:
        throw new Error(`Unknown verb type: ${verb}`);
    }
  } catch (error) {
    console.error('Error decoding parameters:', error);
    return null;
  }
}

/**
 * Gets current PvP statuses from contract
 */
async function getPvpStatuses(contractAddress: string, chainId: number, agentAddress: string): Promise<PvpStatus[]> {
  try {
    const contract = getRoomContract(contractAddress, chainId);
    const statuses = await contract.getPvpStatuses(agentAddress);

    const parsedStatuses = statuses.map((status: any) => {
      //TODO can safe parse here
      const verb = status.verb;
      const endTime = Number(status.endTime);
      const parameters = decodeParameters(status.parameters, verb);
      const instigator = status.instigator;
      return { verb, endTime, parameters, instigator };
    });

    return parsedStatuses;
  } catch (error) {
    console.error('Error fetching PvP statuses:', error);
    return [];
  }
}

// applySilenceEffect
// If sender is silent, empty targetMessages
function applySilenceEffect({
  senderStatuses,
  targetMessages,
  currentBlockTimestamp,
}: {
  senderStatuses: PvpStatus[];
  targetMessages: Record<number, z.infer<typeof agentMessageInputSchema>>;
  currentBlockTimestamp: number;
}): Record<number, z.infer<typeof agentMessageInputSchema>> {
  console.log('applying silence effect');
  // console.log('senderStatuses', senderStatuses);
  // console.log('targetMessages', targetMessages);
  // console.log('currentBlockTimestamp', currentBlockTimestamp);
  const silenced = senderStatuses.find((status) => {
    return status.verb.toLowerCase() === 'silence' && status.endTime > currentBlockTimestamp;
  });

  if (silenced) {
    console.log('sender is silent, empty targetMessages');
    return {} as Record<number, z.infer<typeof agentMessageInputSchema>>;
  }

  return targetMessages;
}

// applyDeafenEffect
// If a given target is deafened, remove them from targetMessages
function applyDeafenEffect({
  targetStatuses,
  targetMessages,
  currentBlockTimestamp,
}: {
  targetStatuses: Record<string, PvpStatus[]>;
  targetMessages: Record<string, z.infer<typeof agentMessageInputSchema>>;
  currentBlockTimestamp: number;
}): Record<number, z.infer<typeof agentMessageInputSchema>> {
  for (const targetId of Object.keys(targetMessages)) {
    const targetStatus = targetStatuses[targetId];
    const deaf = targetStatus.find((status) => {
      return status.verb.toLowerCase() === 'deafen' && status.endTime > currentBlockTimestamp;
    });
    if (deaf) {
      console.log(`target ${targetId} is deaf, remove from targetMessages`);
      delete targetMessages[targetId];
    }
  }
  return targetMessages;
}

// applyPoisonEffect
// If sender is poisoned, find and replace on every target message
// Then check if each target is poisoned and apply the poison effect to their individual messages
function applyPoisonEffect({
  unmodifiedOriginalMessage,
  senderStatuses,
  targetStatuses,
  targetMessages,
  currentBlockTimestamp,
  senderAddress,
}: {
  unmodifiedOriginalMessage: string;
  senderStatuses: PvpStatus[];
  targetStatuses: Record<string, PvpStatus[]>;
  targetMessages: Record<string, z.infer<typeof agentMessageInputSchema>>;
  currentBlockTimestamp: number;
  senderAddress: string;
}): Record<number, z.infer<typeof agentMessageInputSchema>> {
  // First apply sender's poison if active
  const senderPoisoned = senderStatuses.find(
    (status) => status.verb.toLowerCase() === 'poison' && status.endTime > currentBlockTimestamp
  );

  if (senderPoisoned) {
    console.log('sender is poisoned, find and replace on all target messages');
    const parsedParams = poisonStatusSchema.shape.parameters.safeParse(senderPoisoned.parameters);
    if (!parsedParams.success) {
      console.error('Invalid poison parameters:', parsedParams.error);
      return targetMessages;
    }
    const params = parsedParams.data;
    if (params?.find && params?.replace) {
      // Apply poison to all target messages
      Object.keys(targetMessages).forEach((targetId) => {
        const message = targetMessages[targetId];
        // Do the find and replace and check if the message was modified

        targetMessages[targetId] = {
          ...message,
          content: {
            ...message.content,
            text: message.content.text.replace(
              new RegExp(params.find, params.case_sensitive ? 'g' : 'gi'),
              params.replace
            ),
          },
        };
        if (message.content.text !== unmodifiedOriginalMessage) {
          console.log(`${targetId} message was modified by sender poison`);
          console.log('original message', unmodifiedOriginalMessage);
          console.log('modified message', message.content.text);
        }
      });
    }
  }

  // Then apply each target's poison if active
  for (const [targetId, message] of Object.entries(targetMessages)) {
    const targetStatus = targetStatuses[targetId];
    if (!targetStatus) continue;

    const targetPoisoned = targetStatus.find(
      (status) => status.verb.toLowerCase() === 'poison' && status.endTime > currentBlockTimestamp
    );

    if (targetPoisoned) {
      console.log(`target ${targetId} is poisoned, find and replace on target message`);
      console.log('targetPoisoned', targetPoisoned.parameters);
      const parsedParams = poisonStatusSchema.shape.parameters.safeParse(targetPoisoned.parameters);
      if (!parsedParams.success) {
        console.error('Invalid poison parameters:', parsedParams.error);
        return targetMessages;
      }
      const params = parsedParams.data;

      if (params?.find && params?.replace) {
        const prePoisonMessage = message.content.text;
        // Apply poison to this target's message
        console.log('pre poison message', prePoisonMessage);
        targetMessages[targetId] = {
          ...message,
          content: {
            ...message.content,
            text: message.content.text.replace(
              new RegExp(params.find, params.case_sensitive ? 'g' : 'gi'),
              params.replace
            ),
          },
        };
        if (message.content.text !== prePoisonMessage) {
          console.log(`${targetId} message was modified by target poison`);
          console.log('original message', prePoisonMessage);
          console.log('modified message', message.content.text);
        }
      }
    }
  }

  return targetMessages;
}

/**
 * Takes an agent message and applies active PvP effects before delivery
 */
export async function applyPvp(
  originalMessage: z.infer<typeof agentMessageInputSchema>,
  senderAgentId: number,
  targetAgentIds: number[],
  contractAddress: string,
  chainId: number,
  agentAddresses: Map<number, string>
): Promise<PvPResult> {
  console.log('applying PvP');

  try {
    // console.log('Applying PvP to message', originalMessage);

    const result: PvPResult = {
      originalMessage: originalMessage,
      // originalTargets: targetAgentIds,
      targetMessages: {},
      appliedEffects: [],
      pvpStatusEffects: {},
      currentBlockTimestamp: Number(0),
    };

    // Initialize targetMessages as a copy of source. If no PvP effects are applied, we will send the original message to all targets
    result.targetMessages = Object.fromEntries(targetAgentIds.map((id) => [id, originalMessage]));

    const senderAddress = agentAddresses.get(senderAgentId);
    if (!senderAddress) {
      throw new Error(`No address found for agent ${senderAgentId}`);
    }

    // console.log('Fetching pvp status from the contract for', [...targetAgentIds, senderAgentId]);
    const currentBlock = await getEthersProvider(chainId).getBlock('latest');
    if (!currentBlock) {
      throw new Error('Failed to get current block, cannot apply PvP');
    }
    const currentBlockTimestamp = Number(currentBlock.timestamp);
    result.currentBlockTimestamp = currentBlockTimestamp;

    // console.log('currentBlockTimestamp being used for PvP checks', currentBlockTimestamp);
    const currentStatusesForAgentsById: Record<number, PvpStatus[]> = {};
    for (const targetId of [...targetAgentIds, senderAgentId]) {
      const targetAddress = agentAddresses.get(targetId);
      if (!targetAddress) continue;
      currentStatusesForAgentsById[targetId] = await getPvpStatuses(contractAddress, chainId, targetAddress);
    }
    result.pvpStatusEffects = currentStatusesForAgentsById;

    result.targetMessages = applySilenceEffect({
      senderStatuses: currentStatusesForAgentsById[senderAgentId],
      targetMessages: result.targetMessages,
      currentBlockTimestamp,
    });

    result.targetMessages = applyDeafenEffect({
      targetStatuses: currentStatusesForAgentsById,
      targetMessages: result.targetMessages,
      currentBlockTimestamp,
    });

    result.targetMessages = applyPoisonEffect({
      unmodifiedOriginalMessage: originalMessage.content.text,
      senderStatuses: currentStatusesForAgentsById[senderAgentId],
      targetStatuses: currentStatusesForAgentsById,
      targetMessages: result.targetMessages,
      currentBlockTimestamp,
      senderAddress,
    });

    return result;
  } catch (error) {
    console.error('Error applying PvP effects:', error);
    return {
      originalMessage: originalMessage,
      targetMessages: Object.fromEntries(targetAgentIds.map((id) => [id, originalMessage])),
      appliedEffects: [],
      pvpStatusEffects: {},
      currentBlockTimestamp: Number(Number.MAX_SAFE_INTEGER),
    };
  }
}
