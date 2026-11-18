use webview2_com::{
    AcceleratorKeyPressedEventHandler,
    Microsoft::Web::WebView2::Win32::{
        ICoreWebView2AcceleratorKeyPressedEventArgs2, ICoreWebView2Controller,
        COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN, COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN,
    },
};
use windows::{
    core::{Interface, Result},
    Win32::UI::Input::KeyboardAndMouse::{
        GetKeyState, VK_BROWSER_REFRESH, VK_CONTROL, VK_F5, VK_R,
    },
};

pub fn disable_browser_reload(controller: ICoreWebView2Controller) -> Result<()> {
    let handler = AcceleratorKeyPressedEventHandler::create(Box::new(|_, args| {
        let Some(args) = args else { return Ok(()) };
        unsafe {
            let mut kind = Default::default();
            args.KeyEventKind(&mut kind)?;
            if !matches!(
                kind,
                COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN | COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN
            ) {
                return Ok(());
            }

            let mut key = 0;
            args.VirtualKey(&mut key)?;
            if key == u32::from(VK_F5.0)
                || key == u32::from(VK_BROWSER_REFRESH.0)
                || (key == u32::from(VK_R.0) && GetKeyState(i32::from(VK_CONTROL.0)) < 0)
            {
                // Skip the browser action while still delivering F5 to the editor.
                args.cast::<ICoreWebView2AcceleratorKeyPressedEventArgs2>()
                    .and_then(|args2| args2.SetIsBrowserAcceleratorKeyEnabled(false))
                    .or_else(|_| args.SetHandled(true))?;
            }
        }
        Ok(())
    }));
    // The controller owns the handler for the lifetime of the webview.
    unsafe { controller.add_AcceleratorKeyPressed(&handler, &mut 0) }
}
