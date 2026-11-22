import { render } from 'preact';
import { App } from './ui/App.tsx';
import { Controller } from './ui/controller.ts';
import './ui/styles.css';

const controller = new Controller();
// exposed for end-to-end tests and debugging
(window as unknown as { __confluence: Controller }).__confluence = controller;
render(<App c={controller} />, document.getElementById('app')!);
