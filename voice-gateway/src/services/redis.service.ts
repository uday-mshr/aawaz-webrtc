import Redis from 'ioredis';
import logger from '../utils/logger';

class RedisService {
  public pubClient: Redis;
  public subClient: Redis;

  constructor() {
    const redisConfig = {
      host: process.env.REDIS_HOST || 'localhost',
      port: Number(process.env.REDIS_PORT) || 6379,
    };

    // separate clients for pub and sub are required
    this.pubClient = new Redis(redisConfig);
    this.subClient = new Redis(redisConfig);

    this.pubClient.on('connect', () => logger.info('Redis Publisher Connected'));
    this.pubClient.on('error', (err) => logger.error('Redis Pub Error', { err }));

    this.subClient.on('connect', () => logger.info('Redis Subscriber Connected'));
    this.subClient.on('error', (err) => logger.error('Redis Sub Error', { err }));
  }

  public async publishEvent(channel: string, message: unknown) {
    await this.pubClient.publish(channel, JSON.stringify(message));
  }
}

export default new RedisService();


