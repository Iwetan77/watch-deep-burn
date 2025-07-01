#!/usr/bin/env ts-node

import { SuiClient, getFullnodeUrl, SuiEvent } from '@mysten/sui/client';
import chalk from 'chalk';
import { Command } from 'commander';
import { Table } from 'console-table-printer';

// DeepBook V3 Constants (Official Mainnet)
const DEEPBOOK_PACKAGE_ID = '0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809';
const DEEP_TREASURY_ID = '0x032abf8948dda67a271bcc18e776dbbcfb0d58c8d288a700ff0d5521e57a1ffe';
const DEEP_TOKEN_ADDRESS = '0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270';
const DEEP_TOKEN_TYPE = `${DEEP_TOKEN_ADDRESS}::deep::DEEP`;

// Event types for monitoring burns and treasury operations
const TREASURY_EVENTS = [
  `${DEEPBOOK_PACKAGE_ID}::treasury::BurnEvent`,
  `${DEEPBOOK_PACKAGE_ID}::treasury::DeepBurnEvent`,
  `${DEEP_TOKEN_ADDRESS}::deep::BurnEvent`,
];

interface DeepTokenMetrics {
  currentSupply: number;
  totalBurned: number;
  burnRate24h: number;
  lastBurnTx: string;
  lastBurnAmount: number;
  lastBurnTimestamp: Date;
  treasuryBalance: number;
  burnEvents: BurnEvent[];
  circulatingSupply: number;
}

interface BurnEvent {
  txId: string;
  amount: number;
  timestamp: Date;
  eventType: string;
}

class DeepBurnWatcher {
  private client: SuiClient;
  private metrics: DeepTokenMetrics;
  private refreshInterval: number;
  private unsubscribe: (() => void) | null = null;
  private readonly DEEP_DECIMALS = 6; // DEEP token has 6 decimals

  constructor() {
    this.client = new SuiClient({ url: getFullnodeUrl('mainnet') });
    this.refreshInterval = 15000;
    this.metrics = {
      currentSupply: 0,
      totalBurned: 0,
      burnRate24h: 0,
      lastBurnTx: '',
      lastBurnAmount: 0,
      lastBurnTimestamp: new Date(0),
      treasuryBalance: 0,
      burnEvents: [],
      circulatingSupply: 0,
    };
  }

  async initialize() {
    console.log(chalk.blue.bold('🚀 Initializing DEEP Token Burn Watcher with Real-Time Monitoring'));
    console.log(chalk.gray(`Package ID: ${DEEPBOOK_PACKAGE_ID}`));
    console.log(chalk.gray(`DEEP Token: ${DEEP_TOKEN_TYPE}`));
    
    await this.fetchAllMetrics();
    await this.setupEventSubscription();
    setInterval(() => this.fetchAllMetrics(), this.refreshInterval);
  }

  private async fetchAllMetrics() {
    try {
      const [supply, treasury, circulating] = await Promise.all([
        this.getTotalSupply(),
        this.getTreasuryBalance(),
        this.getCirculatingSupply(),
      ]);

      this.metrics.currentSupply = supply;
      this.metrics.treasuryBalance = treasury;
      this.metrics.circulatingSupply = circulating;
      this.calculateBurnRates();
      this.displayMetrics();
    } catch (error) {
      console.error(chalk.red('Error fetching metrics:'), error);
    }
  }

  private async setupEventSubscription() {
    try {
      // Subscribe to multiple event types that might indicate burns
      for (const eventType of TREASURY_EVENTS) {
        try {
          const unsubscribe = await this.client.subscribeEvent({
            filter: { MoveEventType: eventType },
            onMessage: (event: SuiEvent) => this.processBurnEvent(event, eventType),
          });
          
          if (this.unsubscribe) {
            const prevUnsubscribe = this.unsubscribe;
            this.unsubscribe = () => {
              prevUnsubscribe();
              unsubscribe();
            };
          } else {
            this.unsubscribe = unsubscribe;
          }
          
          console.log(chalk.green(`🔌 Subscribed to ${eventType}`));
        } catch (error) {
          console.log(chalk.yellow(`⚠️  Could not subscribe to ${eventType}: ${error}`));
        }
      }

      if (!this.unsubscribe) {
        console.log(chalk.yellow('⚠️  No event subscriptions successful, trying alternative approach...'));
        await this.setupAlternativeMonitoring();
      }
    } catch (error: unknown) {
      console.error(chalk.red('Event subscription setup error:'), error);
      setTimeout(() => this.setupEventSubscription(), 10000);
    }
  }

  private async setupAlternativeMonitoring() {
    // Alternative: Monitor treasury balance changes
    let lastTreasuryBalance = this.metrics.treasuryBalance;
    
    setInterval(async () => {
      try {
        const currentTreasuryBalance = await this.getTreasuryBalance();
        const balanceChange = lastTreasuryBalance - currentTreasuryBalance;
        
        if (balanceChange > 0) {
          // Treasury balance decreased, likely a burn
          const burnEvent: BurnEvent = {
            txId: `treasury-${Date.now()}`,
            amount: balanceChange,
            timestamp: new Date(),
            eventType: 'TreasuryBalanceDecrease',
          };
          
          console.log(chalk.yellow(`\n🔥 Possible burn detected via treasury balance: ${balanceChange.toLocaleString()} DEEP`));
          this.processBurnEventData(burnEvent);
        }
        
        lastTreasuryBalance = currentTreasuryBalance;
      } catch (error) {
        console.error(chalk.red('Alternative monitoring error:'), error);
      }
    }, 30000); // Check every 30 seconds
  }

  private async processBurnEvent(event: SuiEvent, eventType: string) {
    try {
      const parsedJson = event.parsedJson as any;
      let amount = 0;
      
      // Try to extract amount from different possible field names
      if (parsedJson?.amount) {
        amount = Number(parsedJson.amount) / Math.pow(10, this.DEEP_DECIMALS);
      } else if (parsedJson?.value) {
        amount = Number(parsedJson.value) / Math.pow(10, this.DEEP_DECIMALS);
      } else if (parsedJson?.burned_amount) {
        amount = Number(parsedJson.burned_amount) / Math.pow(10, this.DEEP_DECIMALS);
      }

      const burnEvent: BurnEvent = {
        txId: event.id.txDigest,
        amount: amount,
        timestamp: new Date(Number(event.timestampMs)),
        eventType: eventType,
      };

      console.log(chalk.yellow(`\n🔥 New burn detected: ${burnEvent.amount.toLocaleString()} DEEP`));
      this.processBurnEventData(burnEvent);
    } catch (error) {
      console.error(chalk.red('Error processing burn event:'), error);
    }
  }

  private processBurnEventData(burnEvent: BurnEvent) {
    this.metrics.burnEvents.unshift(burnEvent);
    this.metrics.totalBurned += burnEvent.amount;
    this.metrics.currentSupply -= burnEvent.amount;
    this.metrics.lastBurnTx = burnEvent.txId;
    this.metrics.lastBurnAmount = burnEvent.amount;
    this.metrics.lastBurnTimestamp = burnEvent.timestamp;
    
    // Keep only last 100 events
    if (this.metrics.burnEvents.length > 100) {
      this.metrics.burnEvents = this.metrics.burnEvents.slice(0, 100);
    }
    
    this.calculateBurnRates();
    this.displayMetrics();
  }

  private calculateBurnRates() {
    const now = Date.now();
    const burns24h = this.metrics.burnEvents.filter(event => 
      now - event.timestamp.getTime() < 86400000
    );
    this.metrics.burnRate24h = burns24h.reduce((sum, event) => sum + event.amount, 0);
  }

  private async getTotalSupply(): Promise<number> {
    try {
      const metadata = await this.client.getCoinMetadata({ coinType: DEEP_TOKEN_TYPE });
      if (!metadata) throw new Error('DEEP token metadata not found');
      
      // For Sui coins, total supply might not be directly available
      // We need to use alternative methods or estimate from treasury + circulating
      return this.metrics.currentSupply || 1000000000; // Fallback to known initial supply
    } catch (error) {
      console.error(chalk.yellow('Warning: Could not fetch total supply'), error);
      return this.metrics.currentSupply || 1000000000;
    }
  }

  private async getTreasuryBalance(): Promise<number> {
    try {
      const treasuryObject = await this.client.getObject({
        id: DEEP_TREASURY_ID,
        options: { showContent: true },
      });

      if (!treasuryObject.data?.content || treasuryObject.data.content.dataType !== 'moveObject') {
        throw new Error('Invalid treasury data');
      }

      const fields = treasuryObject.data.content.fields as any;
      
      // Try different field names that might contain the balance
      let balance = 0;
      if (fields.deep_supply) {
        balance = Number(fields.deep_supply) / Math.pow(10, this.DEEP_DECIMALS);
      } else if (fields.balance) {
        balance = Number(fields.balance) / Math.pow(10, this.DEEP_DECIMALS);
      } else if (fields.total_supply) {
        balance = Number(fields.total_supply) / Math.pow(10, this.DEEP_DECIMALS);
      }

      return balance;
    } catch (error) {
      console.error(chalk.yellow('Warning: Could not fetch treasury balance'), error);
      return 0;
    }
  }

  private async getCirculatingSupply(): Promise<number> {
    try {
      // Get all DEEP coin objects to calculate circulating supply
      const coins = await this.client.getAllCoins({
        coinType: DEEP_TOKEN_TYPE,
      });

      const totalCirculating = coins.data.reduce((sum, coin) => {
        return sum + (Number(coin.balance) / Math.pow(10, this.DEEP_DECIMALS));
      }, 0);

      return totalCirculating;
    } catch (error) {
      console.error(chalk.yellow('Warning: Could not fetch circulating supply'), error);
      return 0;
    }
  }

  private displayMetrics() {
    console.clear();
    
    // Main metrics table
    const p = new Table({
      title: 'DEEP Token Metrics (Real-Time)',
      columns: [
        { name: 'metric', title: 'Metric', alignment: 'left', color: 'white' },
        { name: 'value', title: 'Value', alignment: 'right' },
      ],
    });

    const burnPercentage = this.metrics.currentSupply > 0 
      ? (this.metrics.totalBurned / (this.metrics.currentSupply + this.metrics.totalBurned) * 100).toFixed(2)
      : '0.00';

    p.addRows([
      { metric: 'Current Supply', value: chalk.green(this.formatNumber(this.metrics.currentSupply)) + ' DEEP' },
      { metric: 'Circulating Supply', value: chalk.cyan(this.formatNumber(this.metrics.circulatingSupply)) + ' DEEP' },
      { metric: 'Treasury Balance', value: chalk.blue(this.formatNumber(this.metrics.treasuryBalance)) + ' DEEP' },
      { metric: 'Total Burned', value: chalk.red(this.formatNumber(this.metrics.totalBurned)) + ' DEEP' },
      { metric: 'Burn Percentage', value: chalk.red(burnPercentage + '%') },
      { metric: '24h Burn Rate', value: chalk.yellow(this.formatNumber(this.metrics.burnRate24h)) + ' DEEP' },
      { metric: 'Last Burn', value: this.metrics.lastBurnAmount > 0 
        ? chalk.red(`${this.formatNumber(this.metrics.lastBurnAmount)} DEEP (${this.metrics.lastBurnTimestamp.toLocaleTimeString()})`)
        : chalk.gray('No burns detected yet') },
      { metric: 'Last TX', value: this.metrics.lastBurnTx 
        ? chalk.blue(this.metrics.lastBurnTx.slice(0, 12) + '...')
        : chalk.gray('N/A') },
    ]);
    
    p.printTable();
    
    // Recent burns table
    if (this.metrics.burnEvents.length > 0) {
      console.log(chalk.blue.bold('\nRecent Burn Events:'));
      const burnsTable = new Table({
        columns: [
          { name: 'time', title: 'Time', alignment: 'left' },
          { name: 'amount', title: 'Amount (DEEP)', alignment: 'right' },
          { name: 'type', title: 'Event Type', alignment: 'left' },
          { name: 'tx', title: 'Transaction', alignment: 'left' },
        ],
      });
      
      this.metrics.burnEvents.slice(0, 10).forEach(event => {
        burnsTable.addRow({
          time: event.timestamp.toLocaleTimeString(),
          amount: chalk.red(this.formatNumber(event.amount)),
          type: chalk.gray(event.eventType.split('::').pop() || event.eventType),
          tx: chalk.blue(event.txId.slice(0, 8) + '...'),
        });
      });
      
      burnsTable.printTable();
    } else {
      console.log(chalk.gray('\nNo burn events detected yet. Monitoring...'));
    }
    
    console.log(chalk.gray(`\nLast updated: ${new Date().toLocaleTimeString()}`));
    console.log(chalk.gray(`Monitoring ${TREASURY_EVENTS.length} event types for burns`));
  }

  private formatNumber(value: number): string {
    return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }

  async cleanup() {
    if (this.unsubscribe) {
      this.unsubscribe();
    }
  }
}

// CLI Setup
const program = new Command();
program
  .name('deepburn-watcher')
  .description('Real-time DEEP token burn monitor for DeepBook Protocol')
  .version('1.0.0')
  .option('-r, --refresh <seconds>', 'refresh interval in seconds', '15')
  .action(async (options) => {
    const watcher = new DeepBurnWatcher();
    
    // Set custom refresh interval if provided
    if (options.refresh) {
      const interval = parseInt(options.refresh) * 1000;
      if (interval >= 5000) { // Minimum 5 seconds
        (watcher as any).refreshInterval = interval;
      }
    }
    
    process.on('SIGINT', async () => {
      console.log(chalk.yellow('\n\nGracefully shutting down...'));
      await watcher.cleanup();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      console.log(chalk.yellow('\n\nReceived SIGTERM, shutting down...'));
      await watcher.cleanup();
      process.exit(0);
    });

    try {
      await watcher.initialize();
      
      // Keep the process alive
      process.stdin.resume();
    } catch (error) {
      console.error(chalk.red('Failed to initialize watcher:'), error);
      await watcher.cleanup();
      process.exit(1);
    }
  });

program.parse(process.argv);
