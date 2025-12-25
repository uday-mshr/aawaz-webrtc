import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import VoiceDemo from './pages/VoiceDemo';
import QATestPage from './pages/QATestPage';
import './index.css';

function App() {
  return (
    <BrowserRouter>
      <nav style={{ 
        position: 'fixed', 
        top: 0, 
        left: 0, 
        right: 0, 
        background: 'rgba(255, 255, 255, 0.95)', 
        padding: '10px 20px', 
        boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
        zIndex: 1000,
        display: 'flex',
        gap: '20px'
      }}>
        <Link to="/" style={{ textDecoration: 'none', color: '#667eea', fontWeight: 600 }}>Voice Demo</Link>
        <Link to="/qa-test" style={{ textDecoration: 'none', color: '#667eea', fontWeight: 600 }}>QA Test</Link>
      </nav>
      <div style={{ marginTop: '60px' }}>
        <Routes>
          <Route path="/" element={<VoiceDemo />} />
          <Route path="/qa-test" element={<QATestPage />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}

export default App;
