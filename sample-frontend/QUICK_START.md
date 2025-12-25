# Quick Start Guide

## Setup Steps

1. **Install Dependencies**
   ```bash
   cd sample-frontend
   npm install
   ```

2. **Start the Voice Gateway Backend**
   ```bash
   # In voice-gateway directory
   cd ../voice-gateway
   npm run dev
   ```
   Ensure the backend is running on `http://localhost:3000`

3. **Start the Frontend**
   ```bash
   # In sample-frontend directory
   npm run dev
   ```
   The frontend will be available at `http://localhost:5173`

## Testing Flow

1. **Open the app** in your browser at `http://localhost:5173`

2. **Fill the form:**
   - Enter your name
   - Enter your email
   - Enter your mobile number
   - Select a persona (Restaurant Receptionist, University Admission Counsellor, or Clinic Receptionist)

3. **Click "Start Call"**
   - This creates a session via REST API
   - Connects via WebSocket
   - Status should change to "Connected - Ready to talk"

4. **Click "Start Talking"**
   - Browser will request microphone permission
   - Once granted, recording starts
   - Speak into your microphone
   - Audio chunks are sent to the backend in real-time

5. **Listen for AI responses**
   - AI audio responses will be played automatically
   - Conversation transcripts will appear below

6. **End the call**
   - Click "Stop Recording" to stop sending audio
   - Click "End Call" to terminate the session

## Troubleshooting

### Microphone not working
- Check browser permissions for microphone access
- Ensure you're using HTTPS or localhost (required for getUserMedia)

### Connection errors
- Verify backend is running on port 3000
- Check browser console for WebSocket connection errors
- Ensure Redis and MongoDB are running

### No audio playback
- Check browser console for audio decoding errors
- Verify audio format compatibility
- Check browser audio settings

### Session creation fails
- Verify all form fields are filled
- Check backend logs for validation errors
- Ensure MongoDB is connected

## Browser Compatibility

- Chrome/Edge: Full support
- Firefox: Full support
- Safari: May require additional configuration for WebRTC

## Notes

- Audio is recorded at 16kHz sample rate (PCM format)
- Audio chunks are sent in real-time via WebSocket
- Each persona routes to a different Python worker
- Session data is stored in MongoDB

