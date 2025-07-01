#!/usr/bin/env ts-node

import { SuiClient, getFullnodeUrl, SuiEvent } from '@mysten/sui/client';
import chalk from 'chalk';
import { Command } from 'commander';
import { Table } from 'console-table-printer';

// DeepBook Constants
const DEEPBOOK_PACKAGE_ID = '0xdeeef0f175babe1a1b1a71f5f90a0d4a7726a5a5';
const DEEP_TOKEN_TYPE = `${DEEPBOOK_PACKAGE_ID}::deep::DEEP`;
const DEEP_BURN_EVENT = `${DEEPBOOK_PACKAGE_ID}::burn::BurnEvent`;

interface DeepTokenMetrics {
  currentSupply: number;
  totalBurned: number;
  burnRate24h: number;
  lastBurnTx: string;
  lastBurnAmount: number;
  lastBurnTimestamp: Date;
  poolBalance: number;
  burnEvents: BurnEvent[];
}

interface BurnEvent {
  txId: string;
  amount: number;
  timestamp: Date;
}

class DeepBurnWatcher {
  private client: SuiClient;
  private metrics: DeepTokenMetrics;
  private refreshInterval: number;
  private unsubscribe: (() => void) | null = null;

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
      poolBalance: 0,
      burnEvents: [],
    };
  }

  async initialize() {
    console.log(chalk.blue.bold('🚀 Initializing DEEP Token Burn Watcher with Real-Time Monitoring'));
    await this.fetchAllMetrics();
    await this.setupEventSubscription();
    setInterval(() => this.fetchAllMetrics(), this.refreshInterval);
  }

  private async fetchAllMetrics() {
    try {
      const [supply, pool] = await Promise.all([
        this.getTotalSupply(),
        this.getPoolBalance(),
      ]);

      this.metrics.currentSupply = supply;
      this.metrics.poolBalance = pool;
      this.calculateBurnRates();
      this.displayMetrics();
    } catch (error) {
      console.error(chalk.red('Error fetching metrics:'), error);
    }
  }

  private async setupEventSubscription() {
    try {
      this.unsubscribe = await this.client.subscribeEvent({
        filter: { MoveEventType: DEEP_BURN_EVENT },
        onMessage: (event: SuiEvent) => this.processBurnEvent(event),
      });

      console.log(chalk.green('🔌 Connected to real-time burn event stream'));
    } catch (error: unknown) {
      console.error(chalk.red('Initial subscription error:'), error);
      setTimeout(() => this.setupEventSubscription(), 5000);
    }
  }

  private async processBurnEvent(event: SuiEvent) {
    try {
      const parsedJson = event.parsedJson as { amount?: string };
      const burnEvent: BurnEvent = {
        txId: event.id.txDigest,
        amount: parsedJson?.amount ? Number(parsedJson.amount) : 0,
        timestamp: new Date(Number(event.timestampMs)),
      };

      console.log(chalk.yellow(`\n🔥 New burn detected: ${burnEvent.amount.toLocaleString()} DEEP`));
      
      this.metrics.burnEvents.unshift(burnEvent);
      this.metrics.totalBurned += burnEvent.amount;
      this.metrics.currentSupply -= burnEvent.amount;
      this.metrics.lastBurnTx = burnEvent.txId;
      this.metrics.lastBurnAmount = burnEvent.amount;
      this.metrics.lastBurnTimestamp = burnEvent.timestamp;
      
      this.calculateBurnRates();
      this.displayMetrics();
    } catch (error) {
      console.error(chalk.red('Error processing burn event:'), error);
    }
  }

  private calculateBurnRates() {
    const now = Date.now();
    const burns24h = this.metrics.burnEvents.filter(event => 
      now - event.timestamp.getTime() < 86400000
    );
    this.metrics.burnRate24h = burns24h.reduce((sum, event) => sum + event.amount, 0);
  }

  private async getTotalSupply(): Promise<number> {
    const metadata = await this.client.getCoinMetadata({ coinType: DEEP_TOKEN_TYPE });
    if (!metadata) throw new Error('DEEP token metadata not found');
    
    const supply = (metadata as any).supply || "0";
    const decimals = metadata.decimals;
    
    if (supply === undefined) throw new Error('Could not determine token supply');
    return Number(supply) / Math.pow(10, decimals);
  }

  private async getPoolBalance(): Promise<number> {
    try {
      const pool = await this.client.getObject({
        id: `${DEEPBOOK_PACKAGE_ID}::pool::Pool<${DEEP_TOKEN_TYPE}>`,
        options: { showContent: true },
      });

      if (!pool.data?.content || pool.data.content.dataType !== 'moveObject') {
        throw new Error('Invalid pool data');
      }

      const balance = (pool.data.content.fields as { balance?: string })?.balance;
      return balance ? Number(balance) : 0;
    } catch (error) {
      console.error(chalk.yellow('Warning: Could not fetch pool balance'), error);
      return 0;
    }
  }

  private displayMetrics() {
    console.clear();
    const p = new Table({
      title: 'DEEP Token Metrics (Real-Time)',
      columns: [
        { name: 'metric', title: 'Metric', alignment: 'left', color: 'white' },
        { name: 'value', title: 'Value', alignment: 'right' },
      ],
    });

    p.addRows([
      { metric: 'Total Supply', value: chalk.green(this.formatNumber(this.metrics.currentSupply)) },
      { metric: 'Total Burned', value: chalk.red(this.formatNumber(this.metrics.totalBurned)) },
      { metric: '24h Burn Rate', value: chalk.yellow(this.formatNumber(this.metrics.burnRate24h)) },
      { metric: 'Pool Balance', value: chalk.cyan(this.formatNumber(this.metrics.poolBalance)) },
      { metric: 'Last Burn', value: chalk.red(`${this.formatNumber(this.metrics.lastBurnAmount)} (${this.metrics.lastBurnTimestamp.toLocaleTimeString()})`) },
      { metric: 'Last TX', value: chalk.blue(this.metrics.lastBurnTx.slice(0, 12) + '...') },
    ]);
    
    p.printTable();
    
    if (this.metrics.burnEvents.length > 0) {
      console.log(chalk.blue.bold('\nRecent Burn Events:'));
      const burnsTable = new Table({
        columns: [
          { name: 'time', title: 'Time', alignment: 'left' },
          { name: 'amount', title: 'Amount', alignment: 'right' },
          { name: 'tx', title: 'Transaction', alignment: 'left' },
        ],
      });
      
      this.metrics.burnEvents.slice(0, 5).forEach(event => {
        burnsTable.addRow({
          time: event.timestamp.toLocaleTimeString(),
          amount: chalk.red(this.formatNumber(event.amount)),
          tx: chalk.blue(event.txId.slice(0, 8) + '...'),
        });
      });
      
      burnsTable.printTable();
    }
    
    console.log(chalk.gray(`\nLast updated: ${new Date().toLocaleTimeString()}`));
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
  .description('Real-time DEEP token burn monitor (DeepBook compliant)')
  .version('0.1.0')
  .action(async () => {
    const watcher = new DeepBurnWatcher();
    
    process.on('SIGINT', async () => {
      console.log(chalk.yellow('\nGracefully shutting down...'));
      await watcher.cleanup();
      process.exit(0);
    });

    try {
      await watcher.initialize();
    } catch (error) {
      console.error(chalk.red('Failed to initialize watcher:'), error);
      await watcher.cleanup();
      process.exit(1);
    }
  });

program.parse(process.argv);