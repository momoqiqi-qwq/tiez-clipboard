use std::sync::Mutex;

// Never keep this lock across a window/API call: those can dispatch window events.
#[derive(Default)]
struct State {
    ready: bool,
    show_requested: bool,
    generation: u64,
    page_generation: u64,
}

pub struct WindowLifecycle(Mutex<State>);

impl WindowLifecycle {
    pub const fn new() -> Self {
        Self(Mutex::new(State {
            ready: false,
            show_requested: false,
            generation: 0,
            page_generation: 0,
        }))
    }

    /// Queue explicit opens until React has committed content into the transparent window.
    pub fn request_show(&self) -> bool {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if !state.ready {
            state.show_requested = true;
        }
        state.ready
    }

    /// StrictMode and frontend reloads may acknowledge readiness more than once.
    pub fn mark_ready(&self) -> bool {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        state.ready = true;
        std::mem::take(&mut state.show_requested)
    }

    pub fn mark_loading(&self, was_visible: bool) -> u64 {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        state.ready = false;
        state.show_requested |= was_visible;
        state.generation = state.generation.wrapping_add(1);
        state.page_generation = state.page_generation.wrapping_add(1);
        state.page_generation
    }

    /// Let the static recovery shell become reachable if the JS bundle/IPC fails.
    pub fn finish_loading_timeout(&self, page_generation: u64) -> Option<bool> {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if state.ready || state.page_generation != page_generation {
            return None;
        }
        state.ready = true;
        Some(std::mem::take(&mut state.show_requested))
    }

    pub fn request_hide(&self) {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        state.show_requested = false;
        state.generation = state.generation.wrapping_add(1);
    }

    pub fn invalidate_blur(&self) {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        state.generation = state.generation.wrapping_add(1);
    }

    pub fn generation(&self) -> u64 {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).generation
    }

    pub fn accepts_blur(&self, generation: u64) -> bool {
        self.generation() == generation
    }
}

pub static MAIN_WINDOW_LIFECYCLE: WindowLifecycle = WindowLifecycle::new();

#[cfg(test)]
mod tests {
    use super::WindowLifecycle;

    #[test]
    fn stale_blur_cannot_hide_a_reopened_nonactivating_window() {
        let state = WindowLifecycle::new();
        state.mark_ready();
        state.invalidate_blur();
        let queued_blur = state.generation();
        // Tray/hotkey open happens during the 200 ms blur delay. Focus stays false.
        state.invalidate_blur();
        assert!(!state.accepts_blur(queued_blur));
        assert!(state.accepts_blur(state.generation()));
    }

    #[test]
    fn focus_recovery_invalidates_a_previous_blur_even_if_focus_is_lost_again() {
        let state = WindowLifecycle::new();
        let first_blur = state.generation();
        state.invalidate_blur();
        let second_blur = state.generation();
        assert!(!state.accepts_blur(first_blur));
        assert!(state.accepts_blur(second_blur));
    }

    #[test]
    fn startup_waits_for_content_and_shows_only_once() {
        let state = WindowLifecycle::new();
        assert!(!state.request_show());
        assert!(!state.request_show());
        assert!(state.mark_ready());
        assert!(!state.mark_ready());
        assert!(state.request_show());
    }

    #[test]
    fn silent_start_stays_hidden_until_an_explicit_open() {
        let state = WindowLifecycle::new();
        assert!(!state.mark_ready());
        assert!(state.request_show());
    }

    #[test]
    fn reload_waits_for_content_and_preserves_visibility_intent() {
        let state = WindowLifecycle::new();
        state.mark_ready();
        let generation = state.mark_loading(true);
        assert!(!state.request_show());
        assert!(state.mark_ready());
        assert_eq!(state.finish_loading_timeout(generation), None);
        state.mark_loading(false);
        assert!(!state.mark_ready());
    }

    #[test]
    fn only_current_timeout_can_reveal_the_recovery_shell() {
        let state = WindowLifecycle::new();
        let old = state.mark_loading(true);
        let current = state.mark_loading(false);
        assert_eq!(state.finish_loading_timeout(old), None);
        assert_eq!(state.finish_loading_timeout(current), Some(true));
        assert_eq!(state.finish_loading_timeout(current), None);
        assert!(state.request_show());
    }

    #[test]
    fn hide_during_loading_cancels_the_queued_open() {
        let state = WindowLifecycle::new();
        let generation = state.mark_loading(true);
        state.request_hide();
        assert_eq!(state.finish_loading_timeout(generation), Some(false));
        assert!(!state.mark_ready());
    }
}
