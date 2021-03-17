import express from "express";

import GitHubApp from "../lib/gh-app/app";
import { send405 } from "../util/send-error";
import Endpoints from "../../common/endpoints";
import { AppPageState } from "../../common/interfaces/api-types";
import GitHubAppMemento from "../lib/gh-app/app-memento";
import Log from "../logger";

const router = express.Router();

router.route(Endpoints.App.path)
  .get(async (req, res, next) => {
    if (!GitHubApp.isInitialized()) {
      Log.info("App is not initialized; sending empty body");
      const resBody: AppPageState = {
        app: false,
      };

      return res.json(resBody);
    }

    const app = GitHubApp.instance;
    const octo = app.installationOctokit;
    const installationsReq = octo.request("GET /app/installations");
    const repositoriesReq = octo.request("GET /installation/repositories");

    const installations = (await installationsReq).data;
    const repositories = (await repositoriesReq).data.repositories;

    const resBody: AppPageState = {
      app: true,
      appConfig: app.configNoSecrets,
      appUrls: app.urls,
      installations,
      repositories,
    };

    return res.json(resBody);
  })
  .delete(async (req, res, next) => {
    await GitHubAppMemento.clear();
    res.status(204).send();
  })
  .all(send405([ "GET" ]));

export default router;
