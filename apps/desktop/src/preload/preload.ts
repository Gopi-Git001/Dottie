/** Sandboxed preload: the only bridge between renderer and main. */
import { contextBridge, ipcRenderer } from 'electron';
import { buildDottieApi } from './api';

contextBridge.exposeInMainWorld('dottie', buildDottieApi(ipcRenderer));
