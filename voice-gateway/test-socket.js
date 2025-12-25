/**
 * Socket.io Client Test Script
 * 
 * This script tests the Voice Gateway Socket.io connection
 * 
 * Installation:
 *   npm install socket.io-client
 * 
 * Usage:
 *   node test-socket.js
 * 
 * Environment Variables:
 *   SERVER_URL=http://localhost:3000  (default)
 *   ROOM_ID=test-room-123             (default)
 */

const { io } = require('socket.io-client');

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000';
const ROOM_ID = process.env.ROOM_ID || 'test-room-123';

console.log('🚀 Starting Socket.io Connection Test...\n');
console.log(`📡 Connecting to: ${SERVER_URL}`);
console.log(`🏠 Room ID: ${ROOM_ID}\n`);

const socket = io(SERVER_URL, {
  transports: ['websocket'],
  auth: {
    token: 'test-token-123'
  },
  reconnection: false
});

// Connection Events
socket.on('connect', () => {
  console.log('✅ Connected successfully!');
  console.log(`   Socket ID: ${socket.id}\n`);
  
  // Test sequence
  setTimeout(() => testJoinRoom(), 500);
});

socket.on('connect_error', (error) => {
  console.error('❌ Connection Error:', error.message);
  process.exit(1);
});

socket.on('disconnect', (reason) => {
  console.log(`\n🔌 Disconnected: ${reason}`);
  process.exit(0);
});

// Test 1: Join Room
function testJoinRoom() {
  console.log('📝 Test 1: Joining room...');
  socket.emit('join_room', ROOM_ID);
  console.log(`   ✅ Emitted: join_room("${ROOM_ID}")`);
  setTimeout(() => testAudioChunk(), 1000);
}

// Test 2: Send Audio Chunk
function testAudioChunk() {
  console.log('\n📝 Test 2: Sending audio chunk...');
  // Create a small test audio buffer (100 bytes)
  const audioBuffer = Buffer.alloc(100, 0);
  const base64Audio = audioBuffer.toString('base64');
  
  socket.emit('audio_chunk', audioBuffer);
  console.log(`   ✅ Emitted: audio_chunk (${audioBuffer.length} bytes)`);
  console.log(`   📦 Base64: ${base64Audio.substring(0, 50)}...`);
  setTimeout(() => testBuilderAction(), 1000);
}

// Test 3: Builder Action
function testBuilderAction() {
  console.log('\n📝 Test 3: Sending builder action...');
  const builderData = {
    action: 'add_node',
    nodeType: 'voice_input',
    config: {
      label: 'User Input Node',
      enabled: true,
      position: { x: 100, y: 200 }
    }
  };
  
  socket.emit('builder_action', builderData);
  console.log('   ✅ Emitted: builder_action');
  console.log(`   📦 Data:`, JSON.stringify(builderData, null, 2));
  setTimeout(() => testStartSimulation(), 1000);
}

// Test 4: Start Simulation
function testStartSimulation() {
  console.log('\n📝 Test 4: Starting simulation...');
  const simulationConfig = {
    simulationId: `sim-${Date.now()}`,
    agentConfig: {
      voice: 'en-US',
      model: 'gpt-4',
      temperature: 0.7,
      maxTokens: 500
    },
    timeout: 30000,
    metadata: {
      userId: 'test-user',
      sessionId: 'test-session'
    }
  };
  
  socket.emit('start_simulation', simulationConfig);
  console.log('   ✅ Emitted: start_simulation');
  console.log(`   📦 Config:`, JSON.stringify(simulationConfig, null, 2));
  setTimeout(() => waitForAIResponse(), 2000);
}

// Test 5: Wait for AI Audio Response
function waitForAIResponse() {
  console.log('\n📝 Test 5: Waiting for AI audio response...');
  console.log('   ⏳ (This requires a Python worker to publish to Redis)');
  console.log('   💡 To test: Run in Redis CLI:');
  console.log(`      PUBLISH audio_out:${ROOM_ID} '{"audio":"SGVsbG8gV29ybGQ=","timestamp":${Date.now()}}'`);
  
  // Wait 5 seconds for potential AI response
  setTimeout(() => {
    console.log('\n✅ All tests completed!');
    console.log('\n📊 Summary:');
    console.log('   - Connection: ✅');
    console.log('   - Join Room: ✅');
    console.log('   - Audio Chunk: ✅');
    console.log('   - Builder Action: ✅');
    console.log('   - Start Simulation: ✅');
    console.log('   - AI Audio Response: ⏳ (requires external Redis publish)');
    console.log('\n🔌 Disconnecting...\n');
    socket.disconnect();
  }, 5000);
}

// Listen for AI audio chunks
socket.on('ai_audio_chunk', (audio) => {
  console.log('\n🎉 Received AI audio chunk!');
  console.log(`   📦 Audio data: ${audio.substring(0, 50)}...`);
  console.log(`   📏 Length: ${audio.length} characters (base64)`);
});

// Error handling
socket.on('error', (error) => {
  console.error('❌ Socket Error:', error);
});

// Handle process termination
process.on('SIGINT', () => {
  console.log('\n\n⚠️  Interrupted by user');
  socket.disconnect();
  process.exit(0);
});

