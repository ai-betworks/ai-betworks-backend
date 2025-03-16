import { createClient } from '@supabase/supabase-js';
import { Wallet } from 'ethers';
import OpenAI from 'openai';
import { WebSocket } from 'ws';
import { WsMessageTypes } from './schemas/wsServer';
import { Database } from './types/database.types';
import { signPayload } from './utils/auth';

const supabase = createClient<Database>(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

const openai = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY || '',
  baseURL: 'https://openrouter.ai/api/v1',
});

const WEBSOCKET_URL = process.env.WEBSOCKET_URL || 'ws://localhost:3000/ws';
const MIN_DELAY = 500;
const MAX_DELAY = 2000;
const NUM_TEST_USERS = 10;
const CONNECTIONS_PER_USER = 5;
const RECONNECT_INTERVAL = 10000;

const randomDelay = () => Math.floor(Math.random() * (MAX_DELAY - MIN_DELAY + 1)) + MIN_DELAY;

// Generate random user IDs and wallets
const getTestUsers = async () => {
  const userIds = Array.from(
    { length: NUM_TEST_USERS },
    () => Math.floor(Math.random() * 1000) + 1
  );
  console.log('Generated test user IDs:', userIds);
  return userIds;
};

interface RoomConfig {
  token: {
    name: string;
    symbol: string;
    address: string;
    image_url: string;
  };
  pvp_config: {
    enabled: boolean;
    enabled_rules: string[];
  };
  round_duration: number;
}

// Get active room and round
const getActiveRoomAndRound = async () => {
  while (true) {
    const { data: rooms, error } = await supabase
      .from('rooms')
      .select('id, room_config')
      .eq('active', true)
      .limit(1);

    if (error || !rooms?.length) {
      console.log('No active rooms found, retrying in 3 seconds...');
      await new Promise((resolve) => setTimeout(resolve, 3000));
      continue;
    }

    const roomId = rooms[0].id;
    const roomConfig = rooms[0].room_config as unknown as RoomConfig;

    const { data: rounds, error: roundError } = await supabase
      .from('rounds')
      .select('id')
      .eq('room_id', roomId)
      .eq('active', true)
      .limit(1);

    if (roundError || !rounds?.length) {
      console.log('No active rounds found for room', roomId, 'retrying in 3 seconds...');
      await new Promise((resolve) => setTimeout(resolve, 3000));
      continue;
    }

    return { roomId, roundId: rounds[0].id, roomConfig };
  }
};

interface UserMessage {
  message: {
    content: {
      text: string;
    };
  };
  user_id: number;
  created_at: string;
}

interface AgentMessage {
  message: {
    content: {
      originalMessage: {
        content: {
          text: string;
        };
      };
    };
  };
  agent_id: number;
  created_at: string;
  agents?: {
    display_name: string;
  };
}

interface FormattedMessage {
  type: 'user' | 'agent';
  content: {
    content:
      | {
          text: string;
        }
      | {
          originalMessage: {
            content: {
              text: string;
            };
          };
        };
  };
  sender: string;
  timestamp: string;
}

// Get recent messages for context
const getRecentMessages = async (roundId: number): Promise<FormattedMessage[]> => {
  const { data: userMessages } = await supabase
    .from('round_user_messages')
    .select(
      `
      message,
      user_id,
      created_at
    `
    )
    .eq('round_id', roundId)
    .order('created_at', { ascending: false })
    .limit(10);

  const { data: agentMessages } = await supabase
    .from('round_agent_messages')
    .select(
      `
      message,
      agent_id,
      created_at,
      agents!round_agent_messages_agent_id_fkey (
        display_name
      )
    `
    )
    .eq('round_id', roundId)
    .order('created_at', { ascending: false })
    .limit(10);

  const messages: FormattedMessage[] = [
    ...(userMessages?.map((msg) => ({
      type: 'user' as const,
      content: msg.message as UserMessage['message'],
      sender: (msg.message as any).sender || 'Unknown',
      timestamp: msg.created_at,
    })) || []),
    ...(agentMessages
      ?.filter((msg) => (msg.message as any).messageType === 'agent_message')
      .map((msg) => ({
        type: 'agent' as const,
        content: msg.message as AgentMessage['message'],
        sender: msg.agents?.display_name || `Agent ${msg.agent_id}`,
        timestamp: msg.created_at,
      })) || []),
  ].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  return messages;
};

interface Connection {
  ws: WebSocket;
  userId: number;
  wallet: Wallet;
  isSubscribed: boolean;
  currentRoom: { roomId: number; roundId: number } | null;
  roomId: number;
  roundId: number;
  roomConfig: RoomConfig | null;
  reconnectTimeout?: NodeJS.Timeout;
}

// Create a WebSocket connection for a user
function createConnection(userId: number, connections: Connection[]): Connection {
  const ws = new WebSocket(WEBSOCKET_URL);
  const randomWallet = Wallet.createRandom();
  // Convert HDNodeWallet to regular Wallet for signing compatibility
  const wallet = new Wallet(randomWallet.privateKey);
  console.log(`Created connection for user ${userId} with wallet ${wallet.address}`);

  const connection: Connection = {
    ws,
    userId,
    wallet,
    isSubscribed: false,
    currentRoom: null,
    roomId: 0,
    roundId: 0,
    roomConfig: null,
  };

  ws.on('open', async () => {
    console.log(`Connection established for user ${userId}`);
    try {
      // Get active room and round
      const { roomId, roundId, roomConfig } = await getActiveRoomAndRound();
      connection.roomId = roomId;
      connection.roundId = roundId;
      connection.roomConfig = roomConfig;

      // Subscribe to room
      const subscribeMessage = {
        messageType: WsMessageTypes.SUBSCRIBE_ROOM,
        content: {
          roomId,
        },
      };
      const signature = await signPayload(wallet, subscribeMessage.content);
      const signedMessage = { ...subscribeMessage, signature };
      ws.send(JSON.stringify(signedMessage));
      console.log(`User ${userId} subscribed to room ${roomId}`);
      connection.isSubscribed = true;
    } catch (error) {
      console.error(`Failed to subscribe user ${userId} to room:`, error);
    }
  });

  ws.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (message.type === WsMessageTypes.HEARTBEAT) {
      ws.send(JSON.stringify({ type: WsMessageTypes.HEARTBEAT, content: {} }));
    }
  });

  ws.on('error', console.error);

  ws.on('close', () => {
    console.log(`Connection closed for user ${userId}, reconnecting...`);
    setTimeout(() => {
      const newConnection = createConnection(userId, connections);
      connections.push(newConnection);
    }, RECONNECT_INTERVAL);
  });

  return connection;
}

// Generate contextual message using Mistral
const generateContextualMessage = async (
  userId: number,
  walletAddress: string,
  messages: FormattedMessage[],
  roomConfig: RoomConfig | null
) => {
  // Skip if this user was the last one to send a message
  if (messages.length > 0 && messages[0].sender === walletAddress) {
    return null;
  }

  const tokenInfo = roomConfig?.token || { name: 'Unknown', symbol: 'UNKNOWN' };

  const prompt = `You are a crypto trader hanging out in a pump.fun trading room. Your wallet address is ${walletAddress}.
  Generate a natural, casual message that fits the conversation flow.
  
  Style guide:
  - Be casual and social, like you're chatting with friends
  - React naturally to what others are saying
  - You can discuss ${tokenInfo.symbol} but don't force it into every message
  - Use emojis occasionally but don't overdo it 🚀 💬 😎
  - Mix trading chat with general banter
  - Topics can include:
    * Reactions to other messages
    * General market vibes
    * Random observations or questions
    * Trading experiences or stories
    * Casual chitchat (food, weather, etc)
  - Keep messages short and natural (1-2 sentences, max 20 words)
  
  IMPORTANT RULES:
  - Never repeat or closely paraphrase recent messages
  - Never open with the same word as previous messages
  - Keep responses in one line
  - Don't direct message or @ mention agents (but feel free to react to them)
  - Stay casual and conversational
  - Don't make specific price predictions
  - Let the conversation flow naturally

  
  Recent conversation history (most recent first):
  ${messages
    .map((msg) => {
      const messageText =
        msg.type === 'user'
          ? (msg.content.content as { text: string }).text
          : (msg.content.content as { originalMessage: { content: { text: string } } })
              .originalMessage.content.text;
      return `[${msg.type === 'user' ? 'User' : 'Agent'}] ${msg.sender}: ${messageText}`;
    })
    .join('\n')}
  
  Your message:`;

  const completion = await openai.chat.completions.create({
    model: 'mistralai/mistral-small-24b-instruct-2501',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7,
  });

  return (
    completion.choices[0].message.content?.trim() || `Anyone else trading while having coffee? ☕️`
  );
};

async function generateMessages() {
  const connections: Connection[] = [];
  const userIds = await getTestUsers();

  // Create connections for each user
  for (const userId of userIds) {
    for (let i = 0; i < CONNECTIONS_PER_USER; i++) {
      const connection = createConnection(userId, connections);
      if (connection) {
        connections.push(connection);
      }
    }
  }

  // Main message generation loop
  setInterval(async () => {
    const activeConnections = connections.filter((conn) => conn.ws.readyState === WebSocket.OPEN);
    if (activeConnections.length === 0) return;

    // Get a random connection
    const connection = activeConnections[Math.floor(Math.random() * activeConnections.length)];
    if (!connection.isSubscribed) return;

    try {
      // Get recent messages for context
      const messages = await getRecentMessages(connection.roundId);

      // Generate contextual message
      const messageText = await generateContextualMessage(
        connection.userId,
        connection.wallet.address,
        messages,
        connection.roomConfig
      );

      // Skip if no message was generated
      if (!messageText) return;

      // Create the message content
      const messageContent = {
        timestamp: Date.now(),
        roomId: connection.roomId,
        roundId: connection.roundId,
        text: messageText,
      };

      // Create the complete message with all required fields
      const message = {
        messageType: WsMessageTypes.PUBLIC_CHAT,
        sender: connection.wallet.address,
        content: messageContent,
      };

      // Sign the message content
      const signature = await signPayload(connection.wallet, messageContent);
      const signedMessage = { ...message, signature };

      // Send the message
      connection.ws.send(JSON.stringify(signedMessage));
      console.log(`User ${connection.wallet.address} sent message: ${messageText}`);
    } catch (error) {
      console.error('Error generating/sending message:', error);
    }
  }, randomDelay());
}

// Start the generator
generateMessages().catch(console.error);
