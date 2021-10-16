import { Inject, Injectable, LoggerService } from '@nestjs/common';
import { performance } from 'perf_hooks';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { ProviderService, ERROR_LIMIT_EXCEEDED } from 'provider';
import { LidoService } from 'lido';
import { DepositAbi, DepositAbi__factory } from 'generated';
import { DepositEventEvent } from 'generated/DepositAbi';
import {
  DEPOSIT_EVENTS_STEP,
  DEPOSIT_EVENTS_FRESH_BLOCKS,
  DEPOSIT_EVENTS_RETRY_TIMEOUT_MS,
  getDeploymentBlockByNetwork,
  DEPOSIT_EVENTS_CACHE_UPDATE_BLOCK_RATE,
  DEPOSIT_EVENTS_CACHE_LAG_BLOCKS,
} from './deposit.constants';
import { DepositCacheService } from './cache.service';
import { DepositEvent, DepositEventGroup } from './interfaces';
import { sleep } from 'utils';

@Injectable()
export class DepositService {
  constructor(
    @Inject(WINSTON_MODULE_NEST_PROVIDER) private logger: LoggerService,
    private providerService: ProviderService,
    private lidoService: LidoService,
    private cacheService: DepositCacheService,
  ) {}

  private cachedContract: DepositAbi | null = null;
  private isCollectingEvents = false;

  public formatEvent(rawEvent: DepositEventEvent): DepositEvent {
    const { args, transactionHash: tx, blockNumber } = rawEvent;
    const { withdrawal_credentials: wc, pubkey, amount, signature } = args;

    return { pubkey, wc, amount, signature, tx, blockNumber };
  }

  public async getContract(): Promise<DepositAbi> {
    if (!this.cachedContract) {
      const address = await this.lidoService.getDepositContractAddress();
      const provider = this.providerService.provider;
      this.cachedContract = DepositAbi__factory.connect(address, provider);
    }

    return this.cachedContract;
  }

  public async getDeploymentBlockByNetwork(): Promise<number> {
    const chainId = await this.providerService.getChainId();
    return getDeploymentBlockByNetwork(chainId);
  }

  public async getCachedEvents(): Promise<DepositEventGroup> {
    const cachedEventGroup = await this.cacheService.getCache();
    const deploymentBlock = await this.getDeploymentBlockByNetwork();

    return {
      ...cachedEventGroup,
      startBlock: Math.max(cachedEventGroup.startBlock, deploymentBlock),
      endBlock: Math.max(cachedEventGroup.endBlock, deploymentBlock),
    };
  }

  public async setCachedEvents(eventGroup: DepositEventGroup): Promise<void> {
    return await this.cacheService.setCache(eventGroup);
  }

  public async fetchEventsFallOver(
    startBlock: number,
    endBlock: number,
  ): Promise<DepositEventGroup> {
    try {
      return await this.fetchEvents(startBlock, endBlock);
    } catch (error: any) {
      const isLimitExceeded = error?.error?.code === ERROR_LIMIT_EXCEEDED;
      const isTimeout = error?.code === 'TIMEOUT';
      const isPartitionRequired = isTimeout || isLimitExceeded;

      const isPartitionable = endBlock - startBlock > 1;

      if (isPartitionable && isPartitionRequired) {
        this.logger.debug?.(`Limit exceeded, try to split the chunk`, {
          startBlock,
          endBlock,
        });

        const center = Math.ceil((endBlock + startBlock) / 2);
        const [first, second] = await Promise.all([
          this.fetchEventsFallOver(startBlock, center - 1),
          this.fetchEventsFallOver(center, endBlock),
        ]);

        const events = first.events.concat(second.events);

        return { events, startBlock, endBlock };
      } else {
        this.logger.warn('Fetch error. Retry', error);

        await sleep(DEPOSIT_EVENTS_RETRY_TIMEOUT_MS);
        return await this.fetchEventsFallOver(startBlock, endBlock);
      }
    }
  }

  public async fetchEvents(
    startBlock: number,
    endBlock: number,
  ): Promise<DepositEventGroup> {
    const contract = await this.getContract();
    const filter = contract.filters.DepositEvent();
    const rawEvents = await contract.queryFilter(filter, startBlock, endBlock);
    const events = rawEvents.map((rawEvent) => this.formatEvent(rawEvent));

    return { events, startBlock, endBlock };
  }

  public async getFreshEvents(): Promise<DepositEventGroup> {
    const endBlock = await this.providerService.getBlockNumber();
    const startBlock = endBlock - DEPOSIT_EVENTS_FRESH_BLOCKS;
    const eventGroup = await this.fetchEventsFallOver(startBlock, endBlock);

    const events = eventGroup.events.length;
    this.logger.debug?.('Fresh events are fetched', {
      startBlock,
      endBlock,
      events,
    });

    return eventGroup;
  }

  private async subscribeToEthereumUpdates() {
    const provider = this.providerService.provider;

    provider.on('block', async (blockNumber) => {
      if (blockNumber % DEPOSIT_EVENTS_CACHE_UPDATE_BLOCK_RATE !== 0) return;
      await this.cacheEvents();
    });

    this.logger.log('DepositService subscribed to Ethereum events');
  }

  public async initialize(): Promise<void> {
    await this.cacheEvents();
    this.subscribeToEthereumUpdates();
  }

  public async cacheEvents(): Promise<{
    newEvents: number;
    totalEvents: number;
  } | void> {
    if (this.isCollectingEvents) return;

    try {
      this.isCollectingEvents = true;
      const fetchTimeStart = performance.now();

      const [currentBlock, initialCache] = await Promise.all([
        this.providerService.getBlockNumber(),
        this.getCachedEvents(),
      ]);

      const eventGroup = { ...initialCache };
      const firstNotCachedBlock = initialCache.endBlock + 1;
      const toBlock = currentBlock - DEPOSIT_EVENTS_CACHE_LAG_BLOCKS;

      for (
        let block = firstNotCachedBlock;
        block <= toBlock;
        block += DEPOSIT_EVENTS_STEP
      ) {
        const chunkStartBlock = block;
        const chunkToBlock = Math.min(
          currentBlock,
          block + DEPOSIT_EVENTS_STEP - 1,
        );

        const chunkEventGroup = await this.fetchEventsFallOver(
          chunkStartBlock,
          chunkToBlock,
        );

        eventGroup.endBlock = chunkEventGroup.endBlock;
        eventGroup.events = eventGroup.events.concat(chunkEventGroup.events);

        this.logger.log('Historical events are fetched', {
          startBlock: chunkStartBlock,
          endBlock: chunkToBlock,
          events: eventGroup.events.length,
        });

        await this.setCachedEvents(eventGroup);
      }

      const totalEvents = eventGroup.events.length;
      const newEvents = totalEvents - initialCache.events.length;

      const fetchTimeEnd = performance.now();
      const fetchTime = Math.ceil(fetchTimeEnd - fetchTimeStart) / 1000;

      this.logger.log('Cache is updated', {
        newEvents,
        totalEvents,
        fetchTime,
      });

      return { newEvents, totalEvents };
    } catch (error) {
      this.logger.error(error);
    } finally {
      this.isCollectingEvents = false;
    }
  }

  public async getAllDepositedPubKeys(): Promise<Set<string>> {
    const [cachedEvents, freshEvents] = await Promise.all([
      this.getCachedEvents(),
      this.getFreshEvents(),
    ]);

    if (cachedEvents.endBlock < freshEvents.startBlock) {
      throw new Error('Events are not collected yet');
    }

    const cachedPubKeys = cachedEvents.events.map(({ pubkey }) => pubkey);
    const freshPubKeys = freshEvents.events.map(({ pubkey }) => pubkey);
    const mergedPubKeys = cachedPubKeys.concat(freshPubKeys);

    return new Set(mergedPubKeys);
  }

  public async getDepositRoot(): Promise<string> {
    const contract = await this.getContract();
    const depositRoot = await contract.get_deposit_root();
    return depositRoot;
  }
}
