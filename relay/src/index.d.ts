// Types pour les tests de l'appli, qui exercent le vrai code du relais.
export class Profil {
  alarm(): Promise<void>;
  constructor(state: unknown);
  fetch(request: Request): Promise<Response>;
}
export class Colis {
  alarm(): Promise<void>;
  constructor(state: unknown);
  fetch(request: Request): Promise<Response>;
}
declare const worker: { fetch(request: Request, env: unknown): Promise<Response> };
export default worker;
