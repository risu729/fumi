declare module "*.js?raw" {
  const code: string;
  export default code;
}
declare module "*.json?raw" {
  const data: string;
  export default data;
}
