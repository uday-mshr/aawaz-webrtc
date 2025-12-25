"""
Redis client for signaling message exchange
"""

import asyncio
import json
import logging
from typing import Callable, Optional
import redis.asyncio as redis

logger = logging.getLogger(__name__)


class RedisClient:
    """Async Redis client for pub/sub messaging"""
    
    def __init__(self, host: str = 'localhost', port: int = 6379):
        self.host = host
        self.port = port
        self.pub_client: Optional[redis.Redis] = None
        self.sub_client: Optional[redis.Redis] = None
        self.pubsub: Optional[redis.client.PubSub] = None
        self._running = False
    
    async def connect(self):
        """Connect to Redis"""
        try:
            self.pub_client = await redis.Redis(
                host=self.host,
                port=self.port,
                decode_responses=False  # Keep binary for signaling
            )
            self.sub_client = await redis.Redis(
                host=self.host,
                port=self.port,
                decode_responses=False
            )
            self.pubsub = self.sub_client.pubsub()
            logger.info(f"Connected to Redis at {self.host}:{self.port}")
        except Exception as e:
            logger.error(f"Failed to connect to Redis: {e}")
            raise
    
    async def subscribe(self, channel: str, callback: Callable[[str, dict], None]):
        """Subscribe to a Redis channel (supports patterns with *)"""
        if not self.pubsub:
            await self.connect()
        
        # Use PSUBSCRIBE for pattern matching (channels with *)
        if '*' in channel:
            await self.pubsub.psubscribe(channel)
            logger.info(f"Subscribed to channel pattern: {channel}")
        else:
            await self.pubsub.subscribe(channel)
            logger.info(f"Subscribed to channel: {channel}")
        
        # Start listening in background
        if not self._running:
            self._running = True
            asyncio.create_task(self._listen(callback))
    
    async def _listen(self, callback: Callable[[str, dict], None]):
        """Listen for messages on subscribed channels"""
        try:
            async for message in self.pubsub.listen():
                msg_type = message['type']
                # Handle both regular messages and pattern-matched messages
                if msg_type == 'message':
                    channel = message['channel'].decode('utf-8')
                elif msg_type == 'pmessage':
                    # Pattern-matched message: 'channel' contains the actual matched channel name
                    channel = message['channel'].decode('utf-8')
                else:
                    continue
                
                try:
                    data = json.loads(message['data'].decode('utf-8'))
                    await callback(channel, data)
                except json.JSONDecodeError as e:
                    logger.error(f"Failed to decode message from {channel}: {e}")
                except Exception as e:
                    logger.error(f"Error processing message from {channel}: {e}")
        except Exception as e:
            logger.error(f"Error in Redis listener: {e}")
            self._running = False
    
    async def publish(self, channel: str, data: dict):
        """Publish a message to a Redis channel"""
        if not self.pub_client:
            await self.connect()
        
        try:
            message = json.dumps(data).encode('utf-8')
            await self.pub_client.publish(channel, message)
            logger.debug(f"Published to channel {channel}: {data.get('type', 'unknown')}")
        except Exception as e:
            logger.error(f"Failed to publish to {channel}: {e}")
            raise
    
    async def unsubscribe(self, channel: str):
        """Unsubscribe from a Redis channel (supports patterns)"""
        if self.pubsub:
            if '*' in channel:
                await self.pubsub.punsubscribe(channel)
            else:
                await self.pubsub.unsubscribe(channel)
            logger.info(f"Unsubscribed from channel: {channel}")
    
    async def close(self):
        """Close Redis connections"""
        self._running = False
        if self.pubsub:
            await self.pubsub.unsubscribe()
            await self.pubsub.close()
        if self.sub_client:
            await self.sub_client.close()
        if self.pub_client:
            await self.pub_client.close()
        logger.info("Redis connections closed")

