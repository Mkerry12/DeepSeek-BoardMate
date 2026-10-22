import { contextBridge, ipcRenderer } from 'electron';
import { createDeskApi } from '../shared/ipc';

contextBridge.exposeInMainWorld('desk', createDeskApi(ipcRenderer));
