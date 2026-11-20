import { useEffect, useState } from "preact/hooks";
import { DEFAULT_OPTIONS, loadOptions, loadToken, normalizeServer, saveOptions, saveToken, type Options } from "../shared/options";

type Gateway = { ok: true; value: { login: string } } | { ok: false; error: { kind: string; message: string } };

export function OptionsPage() {
  const [options, setOptions] = useState<Options>(DEFAULT_OPTIONS);
  const [token, setToken] = useState("");
  const [connection, setConnection] = useState("");
  const [serverInput, setServerInput] = useState("");
  const [serverError, setServerError] = useState("");

  useEffect(() => {
    void loadOptions().then(setOptions);
    void loadToken().then(setToken);
  }, []);

  async function update(patch: Partial<Options>) {
    setOptions(await saveOptions(patch));
  }

  async function checkConnection() {
    setConnection("Checking…");
    try {
      const answer = (await chrome.runtime.sendMessage({
        target: "gateway",
        request: { op: "whoAmI", args: [] },
      })) as Gateway | undefined;
      if (answer?.ok) setConnection(`Connected as ${answer.value.login}`);
      else if (answer?.error.kind === "unauthorized") setConnection("Token invalid or expired");
      else setConnection(`Connection failed: ${answer?.error.message ?? "no answer"}`);
    } catch (e) {
      setConnection(`Connection failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function addServer() {
    const origin = normalizeServer(serverInput);
    if (!origin) return setServerError("Enter an https address");
    if (!options.servers.includes(origin)) {
      if (!(await chrome.permissions.request({ origins: [`${origin}/*`] }))) {
        return setServerError("Permission was not granted");
      }
      await update({ servers: [...options.servers, origin] });
    }
    setServerError("");
    setServerInput("");
  }

  async function removeServer(origin: string) {
    await update({ servers: options.servers.filter((s) => s !== origin) });
    await chrome.permissions.remove({ origins: [`${origin}/*`] });
  }

  return (
    <main>
      <h1>Qommit</h1>
      <section>
        <h2>GitHub</h2>
        <p>
          <label>
            Personal access token{" "}
            <input
              type="password"
              value={token}
              onInput={(e) => {
                const value = e.currentTarget.value;
                setToken(value);
                void saveToken(value);
              }}
            />
          </label>{" "}
          <button type="button" onClick={checkConnection}>Check connection</button>
        </p>
        {connection && <p role="status">{connection}</p>}
        <p>
          <label>
            Organization{" "}
            <input value={options.org} onInput={(e) => void update({ org: e.currentTarget.value.trim() })} />
          </label>
        </p>
        <p>
          <label>
            Repository prefix (optional){" "}
            <input value={options.repoPrefix} onInput={(e) => void update({ repoPrefix: e.currentTarget.value.trim() })} />
          </label>
        </p>
      </section>
      <section>
        <h2>Qlik Sense servers</h2>
        <ul>
          {options.servers.map((server) => (
            <li key={server}>
              <span>{server}</span>{" "}
              <button type="button" onClick={() => void removeServer(server)}>Remove</button>
            </li>
          ))}
        </ul>
        <input
          placeholder="https://qlik.example.com"
          value={serverInput}
          onInput={(e) => setServerInput(e.currentTarget.value)}
        />{" "}
        <button type="button" onClick={() => void addServer()}>Add server</button>
        {serverError && <p role="alert">{serverError}</p>}
      </section>
    </main>
  );
}
