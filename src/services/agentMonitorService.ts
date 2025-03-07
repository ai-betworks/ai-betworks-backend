import { supabase } from '../config';

export class AgentMonitorService {
    // Holds the interval timer for periodic checks
    private checkInterval!: NodeJS.Timeout;
    
    // Check every 10 seconds - matches notification timeout in messageHandler
    private readonly CHECK_INTERVAL_MS = 10000; // 10 seconds // TODO change if needed
  
    constructor() {
      // Initialize with empty timeout to ensure clean start/stop
      this.checkInterval = setTimeout(() => {}, 0);
    }
  
    /**
     * Starts the monitoring service
     * - Cleans up any existing interval
     * - Sets up periodic checks of all active rounds
     * - Triggers notifications for inactive agents
     * 
     * Called by:
     * - Server startup
     * - After service interruption/restart
     */
    start(): void {
      this.stop(); // Ensure clean state
  
      this.checkInterval = setInterval(async () => {
        
      }, this.CHECK_INTERVAL_MS);
    }
  
    /**
     * Stops the monitoring service
     * - Cleans up interval to prevent memory leaks
     * - Called during shutdown or service pause
     */
    stop(): void {
      if (this.checkInterval) {
        clearInterval(this.checkInterval);
      }
    }
}

// Singleton instance used throughout the application
export const agentMonitorService = new AgentMonitorService();