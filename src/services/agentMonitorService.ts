import { supabase } from '../config';
import { roundService } from '../services/roundService';

export class AgentMonitorService {
  // Holds the interval timer for periodic checks
  private checkInterval!: NodeJS.Timeout;

  // Check every 30 seconds - matches the cron job timing in index.ts
  private readonly CHECK_INTERVAL_MS = 30000; // 30 seconds

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
      try {
        // Get all rounds that need monitoring
        const { data: activeRooms, error } = await supabase
          .from('rooms')
          .select(
            `
              *,
              room_agents!inner(id, agent_id, last_message)
            `
          )
          .eq('active', true)
          .or(`last_message.is.null,last_message.lt.${new Date(Date.now() - 30000).toISOString()}`);

        if (error || !activeRooms?.length) return;

        // Process each active round
        for (const room of activeRooms) {
          // Delegates to roundController which:
          // 1. Verifies round is still active
          // 2. Calls messageHandler.processInactiveAgents
          // 3. Handles notification delivery
          await roundService.checkInactiveAgents(room.id);
        }
      } catch (error) {
        console.error('Error in agent monitor service:', error);
      }
    }, this.CHECK_INTERVAL_MS);

    console.log('Agent monitor service started');
  }

  /**
   * Stops the monitoring service
   * - Cleans up interval to prevent memory leaks
   * - Called during shutdown or service pause
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      console.log('Agent monitor service stopped');
    }
  }
}

// Singleton instance used throughout the application
export const agentMonitorService = new AgentMonitorService();
