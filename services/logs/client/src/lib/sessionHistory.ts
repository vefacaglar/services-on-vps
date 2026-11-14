let queries: string[] = [];
export const getHistory = () => queries;
export function rememberQuery(query: string) {
  queries = [query, ...queries.filter((item) => item !== query)].slice(0, 25);
}
let sqlQueries: string[] = [];
export const getSQLHistory = () => sqlQueries;
export function rememberSQL(query: string) {
  sqlQueries = [query, ...sqlQueries.filter((item) => item !== query)].slice(
    0,
    25,
  );
}
export function clearSQLHistory() {
  sqlQueries = [];
}
// Both histories live only in memory and are cleared on sign-out.
export function clearHistory() {
  queries = [];
  sqlQueries = [];
}
