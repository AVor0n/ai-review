import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../product/design/web/tokens.css';
import '../../product/design/web/components.css';
import { App } from './App';
import './styles.css';
import { followSystemTheme } from './theme';

followSystemTheme();

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <App />
    </StrictMode>,
);
