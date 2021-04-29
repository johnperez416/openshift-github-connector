import express from "express";

import ApiEndpoints from "common/api-endpoints";
import { send405, sendError } from "server/util/send-error";
import { exchangeCodeForAppConfig } from "server/lib/github/gh-app-config";
import Log from "server/logger";
import { sendSuccessStatusJSON } from "server/util/server-util";
import ApiRequests from "common/api-requests";
import ApiResponses from "common/api-responses";
import GitHubApp from "server/lib/github/gh-app";
import User from "server/lib/user";
import { exchangeCodeForUserData } from "server/lib/github/gh-util";
import UserInstallation from "server/lib/github/gh-app-installation";

const router = express.Router();

const STATE_TIME_LIMIT_MS = 5 * 60 * 1000;
// const INSTALL_TIME_LIMIT_MS = 15 * 60 * 1000;

const statesInProgress = new Map<string, { iat: number, state: string }>();

// const appsInProgress = new Map<string, { iat: number, ownerId: string, appId: string }>();

// .get(async (req, res, next) => {
//   const state = uuid();
//   creationsInProgress.set(state, { iat: Date.now() /* sessionID: req.sessionID */ });
//   const manifest = getAppManifest(getServerUrl(req, false), getClientUrl(req));

//   const resBody: ApiResponses.CreateAppResponse = {
//     manifest, state,
//   };

//   Log.info(`Heres the manifest`, manifest);

//   return res
//     // this page is not cached or you run into issues with state reuse if you use back/fwd buttons
//     .header(HttpConstants.Headers.CacheControl, "no-store")
//     .json(resBody);
// })

function isExpired(iat: number, limitMs: number): boolean {
  return (Date.now() - iat) > limitMs;
}

router.route(ApiEndpoints.Setup.SetCreateAppState.path)
  .post(async (req, res, next) => {
    const state: string | undefined = req.body.state;
    if (!state) {
      return sendError(res, 400, `Required parameter "state" missing from request body`);
    }

    statesInProgress.set(req.sessionID, { iat: Date.now(), state });

    return sendSuccessStatusJSON(res, 201);
  });

router.route(ApiEndpoints.Setup.CreatingApp.path)
  /*
  .get(async (req, res, next) => {
    const memento = await GitHubAppMemento.tryLoad(req.sessionID);
    if (!memento) {
      return sendError(
        res, 400,
        `No GitHub app secret saved for your session. Please restart the app setup process.`
      );
    }

    // const appWithoutInstallID = await GitHubApp.getApp(memento);
    // const appConfig = await GitHubApp.getAppConfig(appWithoutInstallID);

    const app = await GitHubApp.getAppForSession(req.sessionID);
    if (!app) {
      return sendError(
        res, 400,
        `No GitHub app secret saved for your session. Please restart the app setup process.`
      );
    }
    const appConfig = app.config;

    const appWithSecrets: GitHubAppConfigWithSecrets = {
      ...appConfig,
      client_id: memento.client_id,
      client_secret: memento.client_secret,
      pem: memento.privateKey,
      webhook_secret: memento.webhook_secret,
    };

    if (req.headers.accept?.startsWith("application/json")) {
      return res.json(appWithSecrets);
    }

    const filename = appConfig.slug + ".json";
    // https://github.com/eligrey/FileSaver.js/wiki/Saving-a-remote-file#using-http-header
    res.setHeader(HttpConstants.Headers.ContentType, "application/octet-stream; charset=utf-8");
    res.setHeader(
      HttpConstants.Headers.ContentDisposition,
      `attachment; filename="${filename}"; filename*="${filename}"`
    );
    const appWSecretsString = JSON.stringify(appWithSecrets);
    res.setHeader(HttpConstants.Headers.ContentLength, Buffer.byteLength(appWSecretsString, "utf8"));

    return res.send(appWSecretsString);
  })
  */
  .post(async (
    req: express.Request<any, any, ApiRequests.CreatingApp>,
    res: express.Response<ApiResponses.CreatingAppResponse>,
    next
  ) => {
    const code: string | undefined = req.body.code;
    const state: string | undefined = req.body.state;

    if (!code) {
      return sendError(res, 400, `Required parameter "code" missing from request body`);
    }
    if (!state) {
      return sendError(res, 400, `Required parameter "state" missing from request body`);
    }

    const stateLookup = statesInProgress.get(req.sessionID);
    if (stateLookup == null) {
      Log.info(`State "${state}" not found in state map`);
      return sendError(res, 400, `State parameter "${state}" is invalid or expired`);
    }

    if (isExpired(stateLookup.iat, STATE_TIME_LIMIT_MS)) {
      Log.info(`State "${state}" is expired`);
      statesInProgress.delete(req.sessionID);
      return sendError(res, 400, `State parameter "${state}" is invalid or expired`);
    }

    const appConfig = await exchangeCodeForAppConfig(code);

    req.session.setupData = {
      githubAppId: appConfig.id,
    };
    Log.info(`Saving session data`);

    await GitHubApp.create({
      appId: appConfig.id,
      client_id: appConfig.client_id,
      client_secret: appConfig.client_secret,
      pem: appConfig.pem,
      webhook_secret: appConfig.webhook_secret,
    });

    Log.info(`Saved app ${appConfig.name} into secret`);

    const appInstallUrl = `https://github.com/settings/apps/${appConfig.slug}/installations`;

    // appsInProgress.set(req.sessionID, { iat: Date.now(), appId, ownerId });

    return res.json({
      success: true,
      message: `Successfully saved ${appConfig.name}`,
      appInstallUrl,
    });
  })
  .all(send405([ /* "GET", */ "POST" ]));

router.route(ApiEndpoints.Setup.PostInstallApp.path)
  .post(async (req: express.Request<any, any, ApiRequests.PostInstall>, res, next) => {
    const installationIdStr = req.body.installationId;
    const oauthCode = req.body.oauthCode;

    if (!installationIdStr) {
      return sendError(res, 400, `Required parameter "installationId" missing from request body`);
    }
    else if (!oauthCode) {
      return sendError(res, 400, `Required parameter "oauthCode" missing from request body`);
    }

    if (!req.session.setupData) {
      return sendError(res, 400, `Invalid cookie: missing required field. Please restart the app creation process.`);
    }

    const installationId = Number(installationIdStr);
    if (Number.isNaN(installationId)) {
      return sendError(res, 400, `Installation ID "${installationId}" is not a number`);
    }

    const appId = req.session.setupData.githubAppId;

    const appJustCreated = (await GitHubApp.load(appId));

    if (appJustCreated == null) {
      return sendError(
        res, 500,
        `Failed to look up GitHub app for this session. Please restart the app setup process.`
      );
    }

    const userData = await exchangeCodeForUserData(
      appJustCreated.config.client_id,
      appJustCreated.config.client_secret,
      oauthCode
    );

    if (userData.id !== appJustCreated.config.owner.id) {
      // have to think about this one.
      // there may be cases where this should be allowed (one user creates, another installs)
      // what about the org case?
      return sendError(
        res, 400,
        `Saved Owner ID does not match user who just installed. `
        + `This should not be possible with a private app. Please restart the app creation process.`
      );
    }

    req.session.setupData = undefined;

    req.session.data = {
      githubUserId: userData.id,
    };

    const userInstallation = await UserInstallation.create(appJustCreated, installationId);
    await User.create(userData.id, userData.login, userInstallation);

    return sendSuccessStatusJSON(res, 201);
  })
  .all(send405([ "POST" ]));

// NOTE THAT since post-create-app and post-install-app have their requests originate from github.com,
// these requests have a DIFFERENT session ID cookie
// so you CANNOT try and use it here to persist data.

/*
const CREATION_COOKIE_NAME = "creation_data";
// Prefer to keep this short,
// but we have to leave enough time for user to select all the repositories they want
// and give them a way to recover from failing to do it in time without recreating the app
const CREATION_COOKIE_EXPIRY = 15 * 60 * 1000;
type CreationCookieData = Omit<GitHubAppMemento, "installationId"> & { sessionID: string };

router.route(ApiEndpoints.Setup.PostCreateApp.path)
  .get(async (req, res, next) => {
    // const { code, state } = req.query;
    const state = req.query.state?.toString();
    if (!state) {
      return sendError(
        res, 400,
        `No state provided in querystring. Please restart the app creation process`,
        `Missing state`
      );
    }

    const stateMapValue = creationsInProgress.get(state);
    if (!stateMapValue) {
      return sendError(
        res, 400,
        `The state parameter provided was not issued by this application, `
          + `or has already been claimed. Please restart the app creation process.`,
        `Invalid state`
      );
    }
    creationsInProgress.delete(state);
    const stateAge = Date.now() - stateMapValue.iat;
    if (stateAge > STATE_TIME_LIMIT_MS) {
      return sendError(
        res, 400,
        `The state parameter provided has expired. Please restart the app creation process.`,
        `Expired state`
      );
    }

    res.removeHeader(HttpConstants.Headers.CacheControl);

    const code = req.query.code?.toString();
    if (!code) {
      throw new Error(`No code found in callback URL query`);
    }

    // req.query = {};

    const config = await exchangeCodeForAppConfig(code);

    const creationData: CreationCookieData = {
      appId: config.id,
      privateKey: config.pem,
      sessionID: stateMapValue.sessionID,
    };

    res.cookie(CREATION_COOKIE_NAME, JSON.stringify(creationData), {
      httpOnly: true,
      maxAge: CREATION_COOKIE_EXPIRY,
      secure: req.secure,
      // Because the endpoint that uses this cookie has its request inititated by GitHub,
      // we cannot use the strict SS policy.
      sameSite: "lax",
    });

    const newInstallURL = `https://github.com/settings/apps/${config.slug}/installations`;
    return res.redirect(newInstallURL);
  })
  .all(send405([ "GET" ]));

router.route(ApiEndpoints.Setup.PostInstallApp.path)
  .get(async (req, res, next) => {
    // 'install' or 'update'
    // const setupAction = req.query.setup_action;

    const installationId = req.query.installation_id?.toString();
    if (installationId == null) {
      return sendError(
        res, 400,
        `No installation_id provided in querystring`,
        `Missing installation_id`
      );
    }

    if (Number.isNaN(installationId)) {
      return sendError(
        res, 400, `installation_id "${installationId}" is not a number`,
        `Invalid installation_id`
      );
    }

    const creationCookieRaw = req.cookies[CREATION_COOKIE_NAME];
    if (creationCookieRaw == null) {
      return sendError(
        res, 400, `App creation flow cookie '${CREATION_COOKIE_NAME}' is missing. `
          + `Please restart the app creation process.`,
        `Missing ${CREATION_COOKIE_NAME} cookie`,
      );
    }
    res.clearCookie(CREATION_COOKIE_NAME);

    const creationCookieData = JSON.parse(creationCookieRaw) as CreationCookieData;

    if (!creationCookieData.appId || !creationCookieData.privateKey || !creationCookieData.sessionID) {
      return sendError(
        res, 400,
        `Creation cookie is missing required field. Please restart the app creation process.`,
        `${CREATION_COOKIE_NAME} missing key`,
      );
    }

    Log.info(`Cookie SID is ${req.sessionID}`);
    Log.info(`Saved-state SID is ${creationCookieData.sessionID}`);

    const memento: GitHubAppMemento = {
      appId: creationCookieData.appId,
      privateKey: creationCookieData.privateKey,
      installationId,
    };

    const app = await GitHubApp.create(creationCookieData.sessionID, memento, true);

    Log.info(`Successfully created new GitHub app ${app.config.name}`);

    const clientCallbackUrlRaw = req.query[CLIENT_CALLBACK_QUERYPARAM];
    if (!clientCallbackUrlRaw) {
      return sendError(
        res, 400,
        `Callback URL is missing from query. Please restart the app creation process.`,
        `Missing query parameter`
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    const clientCallbackUrl = clientCallbackUrlRaw.toString();

    Log.debug(`Post-install redirect to ${clientCallbackUrl}`);

    return res.redirect(clientCallbackUrl);
  })
  .all(send405([ "GET" ]));
*/

export default router;
