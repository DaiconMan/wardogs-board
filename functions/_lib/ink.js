// インクのコーデックはクライアントとサーバで完全に一致している必要があるため、
// 実体は public/js/plan/ink.js に1つだけ置き、ここからは再 export する。
//
// EN: The ink codec has to match exactly between client and server, so the single
//     implementation lives in public/js/plan/ink.js and this file only re-exports it.

export * from "../../public/js/plan/ink.js";
