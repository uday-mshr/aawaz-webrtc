#!/usr/bin/env python3
"""
WebRTC Voice Bot Worker
Main entry point for the Python worker that handles WebRTC connections.
"""

import asyncio
import logging
import os
import signal
import sys
from dotenv import load_dotenv

from session_manager import SessionManager
from redis_client import RedisClient

# Load environment variables
load_dotenv()

# Configure logging
logging.basicConfig(
    level=os.getenv('LOG_LEVEL', 'INFO'),
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Global session manager
session_manager = None
redis_client = None


async def shutdown(signal_received=None):
    """Cleanup on shutdown"""
    logger.info("Shutting down worker...")
    if session_manager:
        await session_manager.cleanup()
    if redis_client:
        await redis_client.close()
    sys.exit(0)


def main():
    """Main entry point"""
    global session_manager, redis_client
    
    # Setup signal handlers
    signal.signal(signal.SIGINT, lambda s, f: asyncio.create_task(shutdown()))
    signal.signal(signal.SIGTERM, lambda s, f: asyncio.create_task(shutdown()))
    
    # Initialize Redis client
    redis_host = os.getenv('REDIS_HOST', 'localhost')
    redis_port = int(os.getenv('REDIS_PORT', 6379))
    redis_client = RedisClient(redis_host, redis_port)
    
    # Initialize session manager
    persona = os.getenv('PERSONA', 'restaurant_receptionist')
    gemini_api_key = os.getenv('GEMINI_API_KEY')
    
    if not gemini_api_key:
        logger.error("GEMINI_API_KEY environment variable is required")
        sys.exit(1)
    
    # SessionManager will create the Gemini client internally
    session_manager = SessionManager(redis_client, persona, gemini_api_key)
    
    # Start the worker
    logger.info(f"Starting WebRTC Voice Bot Worker (persona: {persona})")
    try:
        asyncio.run(session_manager.run())
    except KeyboardInterrupt:
        logger.info("Received interrupt signal")
    finally:
        asyncio.run(shutdown())


if __name__ == '__main__':
    main()

