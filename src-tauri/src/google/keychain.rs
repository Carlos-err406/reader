//! Where the desktop Google refresh token lives.
//!
//! On macOS a keychain item's access list names the program that created it, identified by its
//! code signature. Reader is ad-hoc signed, so every build (and every update) looks like a new
//! program and macOS asks for the keychain password again. Going through Apple's own
//! `/usr/bin/security` tool, as Tasker does, gives the item one stable owner: no prompts across
//! rebuilds or updates. The trade-off is that other programs running as this user could read it
//! through the same tool; the keychain still keeps it encrypted at rest.
use crate::error::{bail, Result};

const SERVICE: &str = "org.reader.books.drive";
const ACCOUNT: &str = "google";

#[cfg(target_os = "macos")]
mod platform {
    use super::{ACCOUNT, SERVICE};
    use crate::error::{bail, Error, Result};
    use std::io::Write;
    use std::process::{Command, Stdio};

    const SECURITY: &str = "/usr/bin/security";
    /// `security`'s exit status when the item doesn't exist.
    const NOT_FOUND: i32 = 44;

    /// Quoting for `security -i`, which reads commands from stdin so the token never appears
    /// in a process list.
    pub fn quote(value: &str) -> String {
        let escaped: String = value
            .chars()
            .filter(|c| *c != '\n' && *c != '\r')
            .flat_map(|c| match c {
                '\\' | '"' => vec!['\\', c],
                _ => vec![c],
            })
            .collect();
        format!("\"{escaped}\"")
    }

    pub fn read() -> Result<Option<String>> {
        let output = Command::new(SECURITY)
            .args(["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"])
            .stdin(Stdio::null())
            .output()?;
        match output.status.code() {
            Some(0) => Ok(Some(String::from_utf8_lossy(&output.stdout).trim_end_matches('\n').to_owned())),
            Some(NOT_FOUND) => Ok(None),
            _ => bail!("Could not read Google credentials from the keychain"),
        }
    }

    pub fn write(token: &str) -> Result<()> {
        let mut child = Command::new(SECURITY).arg("-i").stdin(Stdio::piped()).stdout(Stdio::null()).spawn()?;
        let command = format!(
            "add-generic-password -U -s {} -a {} -w {}\n",
            quote(SERVICE),
            quote(ACCOUNT),
            quote(token)
        );
        child
            .stdin
            .take()
            .ok_or_else(|| Error::new("Keychain is unavailable"))?
            .write_all(command.as_bytes())?;
        if !child.wait()?.success() || read()?.as_deref() != Some(token) {
            bail!("Could not save Google credentials in the keychain");
        }
        Ok(())
    }

    pub fn remove() -> Result<()> {
        let status = Command::new(SECURITY)
            .args(["delete-generic-password", "-s", SERVICE, "-a", ACCOUNT])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()?;
        match status.code() {
            Some(0) | Some(NOT_FOUND) => Ok(()),
            _ => bail!("Could not remove Google credentials from the keychain"),
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::{ACCOUNT, SERVICE};
    use crate::error::{Error, Result};

    fn entry() -> Result<keyring::Entry> {
        keyring::Entry::new(SERVICE, ACCOUNT).map_err(|_| Error::new("Keychain is unavailable"))
    }

    pub fn read() -> Result<Option<String>> {
        match entry()?.get_password() {
            Ok(token) => Ok(Some(token)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(Error::new("Could not read Google credentials from the keychain")),
        }
    }

    pub fn write(token: &str) -> Result<()> {
        entry()?.set_password(token).map_err(|_| Error::new("Could not save Google credentials in the keychain"))
    }

    pub fn remove() -> Result<()> {
        match entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(Error::new("Could not remove Google credentials from the keychain")),
        }
    }
}

/// Builds before 0.1.0 stored the token through the `keyring` crate under another name.
/// Moving it costs one last password prompt; afterwards the old item is deleted.
#[cfg(target_os = "macos")]
fn migrate_legacy() -> Result<Option<String>> {
    let Ok(old) = keyring::Entry::new("org.reader.books.google", "drive") else { return Ok(None) };
    match old.get_password() {
        Ok(token) => {
            platform::write(&token)?;
            let _ = old.delete_credential();
            Ok(Some(token))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        // Denied at the prompt: treat as signed out; connecting again stores a fresh token.
        Err(_) => Ok(None),
    }
}

pub fn read() -> Result<Option<String>> {
    match platform::read()? {
        Some(token) if !token.is_empty() => Ok(Some(token)),
        #[cfg(target_os = "macos")]
        _ => migrate_legacy(),
        #[cfg(not(target_os = "macos"))]
        _ => Ok(None),
    }
}

pub fn write(token: &str) -> Result<()> {
    if token.is_empty() {
        bail!("Refusing to store an empty Google credential");
    }
    platform::write(token)
}

pub fn remove() -> Result<()> {
    platform::remove()
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::platform::quote;

    #[test]
    fn quotes_values_for_security_stdin() {
        assert_eq!(quote("plain"), "\"plain\"");
        assert_eq!(quote(r#"a"b\c"#), r#""a\"b\\c""#);
        // A newline would end the command early and let the rest run as another command.
        assert_eq!(quote("x\ndelete-keychain"), "\"xdelete-keychain\"");
    }
}
