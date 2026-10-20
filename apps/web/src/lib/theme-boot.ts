export const themeStorageKey = "proofline.theme";

/** Inlined in <head> (server-rendered): resolves the stored preference before paint, dark when nothing is stored. */
export const themeBootScript = `try{var p=localStorage.getItem("${themeStorageKey}")||"dark";var d=p==="dark"||(p==="system"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.dataset.theme=d?"dark":"light"}catch(e){}`;
