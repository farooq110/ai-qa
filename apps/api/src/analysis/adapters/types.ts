/** A route the code says exists. Hints are verified against the running app before they are trusted. */
export interface RouteHint {
  pattern: string;
  /** Source file of the page, when the adapter can tell. */
  file?: string;
  framework: string;
}
