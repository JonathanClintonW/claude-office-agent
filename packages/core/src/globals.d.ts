// core runs in both Node and the browser; declare only the platform globals it uses.
declare class URL {
  constructor(input: string, base?: string);
  protocol: string;
  host: string;
  pathname: string;
  search: string;
  username: string;
  password: string;
}
