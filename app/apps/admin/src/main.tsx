import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './theme.css';
import { App } from './App';
import { RespondentApp } from './journey/RespondentApp';
import { FirmPortal } from './firm/FirmPortal';
import { PrintReport } from './reports/PrintReport';

const root = document.getElementById('root');
if (!root) throw new Error('Root element #root not found');

// Three strictly separate surfaces by path: the firm portal (/firm) and the
// respondent journey app (/survey) never render the operator admin portal.
const path = window.location.pathname;
const surface = path.startsWith('/print/') ? (
  <PrintReport />
) : path.startsWith('/firm') ? (
  <FirmPortal />
) : path.startsWith('/survey') ? (
  <RespondentApp />
) : (
  <App />
);

createRoot(root).render(<StrictMode>{surface}</StrictMode>);
