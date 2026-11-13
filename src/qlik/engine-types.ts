export interface NxInfo { qId: string; qType: string }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type EngineApi = { [method: string]: (...args: any[]) => Promise<any> };
