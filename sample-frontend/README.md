# Voice Gateway Demo Frontend

React frontend application for testing the Voice Gateway API with persona support.

## Features

- User entry form with persona selection
- Session creation via REST API
- WebSocket connection for real-time communication
- Audio recording and streaming
- AI audio playback
- Conversation transcript display
- Session management

## Prerequisites

- Node.js 18+
- Voice Gateway API running on `http://localhost:3000`
- Redis running
- MongoDB running

## Installation

```bash
cd sample-frontend
npm install
```

## Configuration

Create a `.env` file (optional):

```env
VITE_API_URL=http://localhost:3000/api/v1
VITE_SOCKET_URL=http://localhost:3000
```

## Development

```bash
npm run dev
```

The app will be available at `http://localhost:5173`

## Usage

1. Fill in the entry form:
   - Name
   - Email
   - Mobile number
   - Select a persona (Restaurant Receptionist, University Admission Counsellor, or Clinic Receptionist)

2. Click "Start Call" to create a session

3. Once connected, click "Start Talking" to begin recording

4. Speak into your microphone - audio will be streamed to the AI

5. Listen to AI responses (audio playback)

6. View conversation transcripts

7. Click "End Call" to terminate the session

## Available Personas

- **Restaurant Receptionist**: Handles table bookings, takeaway orders, etc.
- **University Admission Counsellor**: Helps with course information, admissions, etc.
- **Clinic Receptionist**: Manages appointments, doctor availability, etc.

## Architecture

- **REST API**: Session creation and management
- **WebSocket**: Real-time audio streaming and events
- **Audio Processing**: Browser Web Audio API for recording and playback
- **State Management**: React hooks for session and UI state

## Notes

- Microphone permissions are required
- Audio is recorded at 16kHz sample rate (PCM format)
- Audio chunks are sent in real-time via WebSocket
- AI responses are played back automatically

