/// <reference types="vite/client" />

// Declare worker modules
declare module "*?worker" {
  const WorkerFactory: new () => Worker;
  export default WorkerFactory;
}
