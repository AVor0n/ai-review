import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../agents/design/web/tokens.css';
import '../../agents/design/web/components.css';
import { App } from './App';
import { Viewer } from './qa/Viewer';
import './styles.css';
import { followSystemTheme } from './theme';

followSystemTheme();

// Окно просмотра медиа прогона открывается той же страницей с адресом #viewer=…
const viewer = location.hash.startsWith('#viewer=') ? location.hash.slice('#viewer='.length) : null;

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        {viewer !== null ? <Viewer initial={viewer} /> : <App />}
    </StrictMode>,
);
