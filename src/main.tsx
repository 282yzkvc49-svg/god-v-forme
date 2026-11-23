import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { init } from './state/store';
import { registerSW } from './app/sw';
import { installViewportWatch } from './app/viewport';
import './styles.css';

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
init();
registerSW();
installViewportWatch();
