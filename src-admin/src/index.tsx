// Local dev sandbox only - not used in the production build copied into admin/custom.
import React from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';

const container = document.getElementById('root');
if (container) {
    const root = createRoot(container);
    root.render(
        <React.StrictMode>
            <App />
        </React.StrictMode>,
    );
}
