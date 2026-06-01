import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './App';

const params = new URLSearchParams(location.search);

createRoot(document.getElementById('app')!).render(
  <App isEmbedded={params.has('frame_id')} initialRoom={params.get('room') ?? 'local'} />,
);
