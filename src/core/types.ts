export type FileContent = string | Uint8Array; // text as string, appcontent as bytes
export type FileMap = Map<string, FileContent>; // repo path -> content
export interface GenericProps { qInfo: { qId: string; qType: string }; [key: string]: unknown }
export interface PropertyTree { qProperty: GenericProps; qChildren: PropertyTree[] }
export interface AppSnapshot {
  appId: string;
  script: string;
  appProps: PropertyTree[];
  variables: GenericProps[];
  dimensions: GenericProps[];
  measures: GenericProps[];
  masterObjects: PropertyTree[];
  sheets: PropertyTree[];
  stories: PropertyTree[];
  bookmarks: GenericProps[];
  staticFiles: Map<string, Uint8Array>; // file name -> bytes
}
