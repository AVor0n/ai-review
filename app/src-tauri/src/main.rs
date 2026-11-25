// В сборке для Windows без консольного окна
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    pr_reviewer_app_lib::run()
}
