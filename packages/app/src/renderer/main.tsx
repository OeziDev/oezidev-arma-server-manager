import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/app.css';
import { App } from './App';
import { applyMotionClass } from './components/motion';

// Animasyon tercihi ilk çizimden önce uygulansın (açılış ekranı buna bakar)
applyMotionClass();

// Pencereye sürüklenen dosyalar sayfayı değiştirmesin
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
