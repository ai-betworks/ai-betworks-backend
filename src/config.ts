import { createClient } from '@supabase/supabase-js';
import { ethers, Wallet } from 'ethers';
import { type Address } from 'viem'; // keep this type if you want, or use string
import { roomAbi } from './types/contract.types';
import { Database } from './types/database.types';
import { GameContracts } from './utils/contractInteractions';
import { WSOperations } from './ws/operations';

type ChainConfig = {
  rpcUrl: string;
  applicationContractAddress: string;
  signerPrivateKey: string;
};

const CHAIN_CONFIGS: Record<number, ChainConfig> = {
  84532: {
    rpcUrl: process.env.BASE_SEPOLIA_RPC_URL!,
    applicationContractAddress: process.env.BASE_SEPOLIA_APPLICATION_CONTRACT_ADDRESS!,
    signerPrivateKey: process.env.SIGNER_PRIVATE_KEY!,
  },
  57054: {
    rpcUrl: process.env.SONIC_BLAZE_RPC_URL!,
    applicationContractAddress: process.env.SONIC_BLAZE_APPLICATION_CONTRACT_ADDRESS!,
    signerPrivateKey: process.env.SIGNER_PRIVATE_KEY!,
  },
  43113: {
    rpcUrl: process.env.AVALANCHE_FUJI_RPC_URL!,
    applicationContractAddress: process.env.AVALANCHE_FUJI_APPLICATION_CONTRACT_ADDRESS!,
    signerPrivateKey: process.env.SIGNER_PRIVATE_KEY!,
  },
  534351: {
    rpcUrl: process.env.SCROLL_SEPOLIA_RPC_URL!,
    applicationContractAddress: process.env.SCROLL_SEPOLIA_APPLICATION_CONTRACT_ADDRESS!,
    signerPrivateKey: process.env.SIGNER_PRIVATE_KEY!,
  },
};

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL || '';
// const supabaseKey = process.env.SUPABASE_ANON_KEY || "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''; //This is the admin key, use with caution
if (!supabaseUrl || !supabaseKey) {
  throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set');
}

export const wsOps = new WSOperations();
export const supabase = createClient<Database>(supabaseUrl, supabaseKey);
export const AGENT_ENDPOINT = process.env.AGENT_ENDPOINT || '';
export const SIGNATURE_WINDOW_MS = process.env.SIGNATURE_WINDOW_MS
  ? parseInt(process.env.SIGNATURE_WINDOW_MS)
  : 5 * 1000; // 5 seconds in millisecons

export const getEthersSigningWallet = (chainId: number) => {
  if (!CHAIN_CONFIGS[chainId].signerPrivateKey) {
    throw new Error(`SIGNER_PRIVATE_KEY is required for chainId: ${chainId}`);
  }

  return new Wallet(CHAIN_CONFIGS[chainId].signerPrivateKey);
};

export function getContractClient(chainId: number) {
  if (!CHAIN_CONFIGS[chainId]) {
    throw new Error(`No chain config found for chainId: ${chainId}`);
  }

  if (!CHAIN_CONFIGS[chainId].applicationContractAddress) {
    throw new Error(`APPLICATION_CONTRACT_ADDRESS is required for chainId: ${chainId}`);
  }

  return new GameContracts({
    provider: getEthersProvider(chainId),
    wallet: getEthersSigningWallet(chainId),
    coreAddress: CHAIN_CONFIGS[chainId].applicationContractAddress as Address,
  });
}

// TODO: this is temporary, when creating a new agent, we should get the chainId, right?
export function defaultContractClient() {
  return getContractClient(84532);
}

export function getRoomContract(contractAddress: string, chainId: number) {
  if (!CHAIN_CONFIGS[chainId]) {
    throw new Error(`No chain config found for chainId: ${chainId}`);
  }

  const provider = new ethers.JsonRpcProvider(CHAIN_CONFIGS[chainId].rpcUrl);
  const wallet = new ethers.Wallet(process.env.SIGNER_PRIVATE_KEY!, provider);
  console.log('wallet', wallet);
  return new ethers.Contract(contractAddress, roomAbi, wallet);
}

export function getEthersProvider(chainId: number) {
  const chainConfig = CHAIN_CONFIGS[chainId];
  if (!chainConfig) {
    throw new Error(`No chain config found for chainId: ${chainId}`);
  }
  console.log('chainConfig', chainConfig);
  console.log('chainConfig.rpcUrl', chainConfig.rpcUrl);

  return new ethers.JsonRpcProvider(chainConfig.rpcUrl);
}

// export const ethersProvider = new ethers.JsonRpcProvider(process.env.BASE_SEPOLIA_RPC_URL);
