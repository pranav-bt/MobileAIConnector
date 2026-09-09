import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './theme.css';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('missing #root element');

createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
