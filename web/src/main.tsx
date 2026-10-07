import React from "react";
import ReactDOM from "react-dom/client";
import { Amplify } from "aws-amplify";

import { App } from "./App";
import { config } from "./config";
import "./styles.css";

Amplify.configure({
  Auth: {
    Cognito: {
      userPoolId: config.userPoolId,
      userPoolClientId: config.userPoolClientId,
      identityPoolId: config.identityPoolId,
      allowGuestAccess: false,
    },
  },
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
