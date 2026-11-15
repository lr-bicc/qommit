import type { AppSnapshot } from "../../src/core/types";
export const APP_ID = "11111111-1111-4111-8111-111111111111";
export const CANON_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export function makeSnapshot(): AppSnapshot {
  return {
    appId: APP_ID,
    script: "///$tab Main\r\nSET a=1;\r\n///$tab Load / Data\r\nLOAD * INLINE [x];\r\n",
    appProps: [{ qProperty: { qInfo: { qId: "appprops-1", qType: "appprops" }, theme: "t" }, qChildren: [] }],
    variables: [
      { qInfo: { qId: "var-1", qType: "variable" }, qName: "vUser", qDefinition: "1" },
      { qInfo: { qId: "var-2", qType: "variable" }, qName: "vToday", qDefinition: "01.01.2026", qIsScriptCreated: true },
    ],
    dimensions: [{ qInfo: { qId: "dim-1", qType: "dimension" }, qDim: { qFieldDefs: ["Country"] }, qMetaDef: { title: "Country" } }],
    measures: [{ qInfo: { qId: "mes-1", qType: "measure" }, qMeasure: { qDef: "Sum(Sales)" }, qMetaDef: { title: "Sales" } }],
    masterObjects: [{ qProperty: { qInfo: { qId: "mo-1", qType: "masterobject" }, qMetaDef: { title: "KPI" } }, qChildren: [] }],
    sheets: [{
      qProperty: { qInfo: { qId: "sh-1", qType: "sheet" }, qMetaDef: { title: "Overview" },
        thumbnail: { qStaticContentUrlDef: { qUrl: `/appcontent/${APP_ID}/logo.png` } } },
      qChildren: [{ qProperty: { qInfo: { qId: "obj-1", qType: "barchart" } }, qChildren: [] }],
    }],
    stories: [],
    bookmarks: [{ qInfo: { qId: "bm-1", qType: "bookmark" }, qMetaDef: { title: "Germany" } }],
    staticFiles: new Map([["logo.png", new Uint8Array([137, 80, 78, 71])]]),
  };
}
